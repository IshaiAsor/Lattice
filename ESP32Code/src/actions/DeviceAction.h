#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include <functional>
#include "actions/ActionPinsSetup.h"
#include "config/Log.h"

// Result of a command execution, returned so the MQTT callback can publish the ack right at
// the call site (keeps ack logic out of the action classes entirely).
struct ActionResult
{
    bool   ok;
    String commandId; // empty for unsolicited changes (auto-off, boot restore)
    String value;     // state the device actually applied
};

// Callback used to publish a telemetry reading (topic slot = action name, payload = value).
using TelemetryCallback = std::function<void(const char*, const char*)>;

// Unified base for every device action. "Command" and "telemetry" are no longer separate class
// trees — they are two optional *surfaces* a single action can expose:
//   • COMMAND surface (actuators): execute(payload) + NVS-persisted state + acks.
//   • READ surface (sensors/camera): cyclic and/or on-demand readings.
// The service holds ONE std::vector<DeviceAction*> and the MQTT handler dispatches by verb, so
// an action's behavior is which surface(s) it implements — not which list it lives in. This is
// the firmware side of the catalog's behavior rows (command | interval | on_demand).
class DeviceAction
{
  protected:
    // Per-instance enabled behaviors (from the user's catalog selection, served in the device
    // config). Default all-true so an action with no explicit behavior list keeps its full
    // class surface (backward compatible with an older gateway that omits the list).
    bool _behaviorCommand  = true;
    bool _behaviorInterval = true;
    bool _behaviorOnDemand = true;

  public:
    String                       actionName;
    std::vector<ActionPinsSetup> actionPinsSetup;

    DeviceAction(String name, std::vector<ActionPinsSetup> pins) : actionName(name), actionPinsSetup(pins) {}
    virtual ~DeviceAction() {}

    // Applied once after construction from the resolved behavior rows.
    void setBehaviors(bool command, bool interval, bool onDemand)
    {
        _behaviorCommand  = command;
        _behaviorInterval = interval;
        _behaviorOnDemand = onDemand;
    }
    bool commandEnabled() const { return _behaviorCommand; }
    bool intervalEnabled() const { return _behaviorInterval; }
    bool onDemandEnabled() const { return _behaviorOnDemand; }

    virtual void initPins()
    {
        for (size_t i = 0; i < actionPinsSetup.size(); i++)
        {
            pinMode(actionPinsSetup[i].PIN_NUMBER, actionPinsSetup[i].PIN_MODE);
            LOG_D("Action", "pin %d set to mode %d", actionPinsSetup[i].PIN_NUMBER, actionPinsSetup[i].PIN_MODE);
        }
    }

    // Per-tick maintenance, called for every action each loop. Telemetry actions do interval
    // reads (publishing via cb); command actions do duration auto-off (cb unused).
    virtual void tick(unsigned long currentTime, TelemetryCallback cb) = 0;

    // ── command surface (default: not a command action) ──────────────────────────────────
    virtual bool         hasCommandSurface() const { return false; }
    virtual ActionResult execute(String /*payload*/) { return {false, "", ""}; }
    virtual String       getState() { return ""; }
    // Boot-time NVS state restore (command actions re-apply + ack their last state). No-op for
    // read-only actions, so the boot loop can call it uniformly on every action.
    virtual void loadState() {}

    // ── read surface (default: not readable on demand) ───────────────────────────────────
    virtual bool hasReadSurface() const { return false; }
    // Immediate read (bypasses the cyclic interval), publishing an envelope tagged with
    // commandId so the backend can correlate the answer to the request.
    virtual void readNow(TelemetryCallback /*cb*/, const String& /*commandId*/) {}
};
