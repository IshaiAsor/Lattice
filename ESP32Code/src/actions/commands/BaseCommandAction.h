#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include <ArduinoJson.h>
#include "services/PreferencesManagerService.h"
#include <actions/ActionPinsSetup.h>
#include <actions/AckPublisher.h>
#include "actions/DeviceAction.h"
#include "actions/commands/PayloadValidation.h"
#include "config/Log.h"

// Command surface of DeviceAction — actuators with a validated payload, NVS-persisted state,
// duration auto-off, and acks. Leaf classes (Outlet/Motor/Dimmer/OnboardLed) override only
// executeValidAction(); the unified type + verb dispatch live in DeviceAction.
class BaseCommandAction : public DeviceAction
{
  protected:
    bool hasRange = false;
    int  rangeMin = 0;
    int  rangeMax = 0;

    int32_t       _durationMs     = -1;
    unsigned long _durationStart  = 0;
    bool          _durationActive = false;

    String state;

    // Delegates to the pure PayloadValidation::isValid so the exact acceptance semantics
    // live in one natively-testable place (see PARITY.md). Behavior is unchanged.
    bool validateActionPayload(String action)
    {
        return PayloadValidation::isValid(std::string(action.c_str()), validParameters, hasRange, rangeMin, rangeMax);
    }

    // Returns true if the action was valid and applied, false if rejected.
    bool applyAction(String action, int32_t durationMs = -1)
    {
        if (validateActionPayload(action))
        {
            LOG_D("Cmd", "executing valid action: %s", action.c_str());
            executeValidAction(action);
            state = action;
            prefService.SaveActionState((char*)actionName.c_str(), (char*)action.c_str());
            if (durationMs > 0)
            {
                _durationMs     = durationMs;
                _durationStart  = millis();
                _durationActive = true;
            }
            else
            {
                _durationActive = false;
            }
            return true;
        }
        LOG_W("Cmd", "invalid parameter: %s", action.c_str());
        return false;
    }

    virtual void executeValidAction(String action) = 0;

  private:
    PreferencesManagerService prefService;

  public:
    std::vector<std::string> validParameters;

    BaseCommandAction(String name, std::vector<ActionPinsSetup> pinsSetup, std::vector<std::string> validParams)
        : DeviceAction(name, pinsSetup)
    {
        validParameters = validParams;
    }

    BaseCommandAction(String name, std::vector<ActionPinsSetup> pinsSetup, std::vector<std::string> validParams,
                      bool useRange, int rMin, int rMax)
        : DeviceAction(name, pinsSetup)
    {
        validParameters = validParams;
        hasRange        = useRange;
        rangeMin        = rMin;
        rangeMax        = rMax;
    }

    bool hasCommandSurface() const override { return true; }

    // Bridges the unified per-tick call to the command-specific loop() (duration auto-off /
    // OnboardLed blink); the telemetry callback is unused for command actions.
    void tick(unsigned long /*currentTime*/, TelemetryCallback /*cb*/) override { loop(); }

    virtual ~BaseCommandAction() {}

    // Current NVS-persisted state, without executing anything. Backs the reserved `read`
    // verb so the backend can query an actuator's state (e.g. after a restart, once
    // loadState() has repopulated `state` from NVS).
    String getState() override
    {
        if (state.length() == 0)
            state = prefService.LoadActionState((char*)actionName.c_str());
        return state;
    }

    // Restores the last saved state from NVS on boot. Publishes an unsolicited ack (no
    // commandId) so the backend records the restored state as authoritative.
    void loadState() override
    {
        String lastState = prefService.LoadActionState((char*)actionName.c_str());
        if (lastState.length() > 0)
        {
            bool ok = applyAction(lastState);
            if (ackPublisher)
                ackPublisher(actionName.c_str(), "", ok, lastState.c_str());
        }
    }

    // Duration auto-off. Publishes an unsolicited ack (no commandId) so the backend
    // records the "off" as the authoritative state even though no user command caused it.
    virtual void loop()
    {
        if (_durationActive && (millis() - _durationStart) >= (unsigned long)_durationMs)
        {
            _durationActive = false;
            applyAction("off");
            if (ackPublisher)
                ackPublisher(actionName.c_str(), "", true, "off");
        }
    }

    // Parses JSON payload {"value":"on","duration":30,"commandId":"..."} and applies it.
    // Returns the result so the MQTT callback can publish the ack at the call site.
    ActionResult execute(String payload) override
    {
        JsonDocument         doc;
        DeserializationError err = deserializeJson(doc, payload);

        String  action;
        String  commandId;
        int32_t durationMs = -1;

        if (!err && !doc["value"].isNull())
        {
            action          = doc["value"].as<String>();
            JsonVariant dur = doc["duration"];
            if (!dur.isNull() && strcmp(dur.as<const char*>(), "*") != 0)
                durationMs = (int32_t)(dur.as<float>() * 1000.0f);
            JsonVariant cid = doc["commandId"];
            if (!cid.isNull())
                commandId = cid.as<String>();
        }
        else
        {
            action = payload;
        }

        bool ok = applyAction(action, durationMs);
        return {ok, commandId, ok ? state : action};
    }
};
