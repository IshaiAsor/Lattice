#pragma once
#include <Arduino.h>
#include <vector>
#include "actions/models/ActionConfig.h"
#include "actions/DeviceAction.h"
#include "actions/commands/BaseCommandAction.h"
#include "actions/telemetries/BaseTelemetryAction.h"
#include "actions/commands/OutletCommandAction.h"
#include "actions/commands/OneDirectionalMotor.h"
#include "actions/commands/LightDimmerAction.h"
#include "actions/commands/PwmOutputAction.h"
#include "actions/commands/I2cSocket8Action.h"
#include "actions/commands/I2cSocket16Action.h"
#include "actions/commands/OnboardLedCommandAction.h"
#include "actions/telemetries/TemperatureAction.h"
#include "actions/telemetries/WaterLevelAction.h"
#include "actions/telemetries/PhLevelAction.h"
#include "actions/telemetries/TdsLevelAction.h"
#include "actions/telemetries/HumidityAction.h"
#include "actions/telemetries/AirTemperatureAction.h"
#include "actions/telemetries/CO2LevelAction.h"
#ifdef HAS_CAMERA
#include "actions/telemetries/CameraAction.h"
#include "services/LiveStreamService.h"
#include "services/HttpFrameService.h"
extern LiveStreamService cameraWsService;
extern HttpFrameService  httpFrameService;
extern const char*       root_ca;
#endif
#include "services/HttpJsonClientService.h"
#include "services/PreferencesManagerService.h"
#include "config/settings.h"
#include "config/Log.h"
#ifndef ONBOARD_LED_PIN
#define ONBOARD_LED_PIN 48
#endif
// Single instance defined in main.cpp (the sole translation unit); every header that drives
// the status LED shares it by extern declaration rather than a header-scope `static`.
extern OnboardLedAction onboardLed;

class DynamicDeviceActionsService
{
  private:
    // One unified list — command and read surfaces both live here as DeviceAction*. The MQTT
    // handler dispatches by verb + surface, not by which list an action was found in.
    std::vector<DeviceAction*> _actions;
    bool                       _ownedByServer = false;
#ifdef HAS_CAMERA
    // At most one per device (one-camera-per-device provisioning rule) — kept as a typed
    // handle so the legacy take_picture command can reach triggerCapture() directly.
    CameraAction* _cameraAction = nullptr;
#endif

    // Validates pin count against the class blueprint and logs the named slot mapping.
    bool validateAndLogPins(const ActionConfig& ac, const PinSlotDef* blueprint)
    {
        size_t required = 0;
        while (blueprint[required].key != nullptr)
            required++;

        if (required == 0)
        {
            LOG_D("Config", "  (no user-configurable pins — board macros handle GPIO)");
            return true;
        }

        if (ac.pins.size() < required)
        {
            LOG_E("Config", "%s '%s' needs %d pin(s), got %d:", ac.implementation_type.c_str(),
                  ac.mqtt_action_name.c_str(), (int)required, (int)ac.pins.size());
            for (size_t i = 0; i < required; i++)
            {
                bool present = i < ac.pins.size();
                LOG_E("Config", "  [%s] %s — %s", blueprint[i].key, blueprint[i].label, present ? "OK" : "MISSING");
            }
            return false;
        }

        for (size_t i = 0; i < required; i++)
        {
            LOG_D("Config", "  [%s] %s → GPIO%d (%s)", blueprint[i].key, blueprint[i].label, ac.pins[i].PIN_NUMBER,
                  blueprint[i].mode == OUTPUT ? "OUTPUT" : "INPUT");
        }
        return true;
    }

    // Logs the Google traits that this action class supports.
    void logSupportedTraits(const GoogleTraitDef* traits)
    {
        if (traits == nullptr || traits[0].traitValue == nullptr)
        {
            LOG_D("Config", "  supported traits: (none — read-only)");
            return;
        }
        String traitList = "";
        for (size_t i = 0; traits[i].traitValue != nullptr; i++)
        {
            if (i > 0)
                traitList += ", ";
            traitList += traits[i].label;
        }
        LOG_D("Config", "  supported traits: %s", traitList.c_str());
    }

    template <typename T> DeviceAction* tryCreateCmd(const ActionConfig& ac)
    {
        if (strcmp(ac.implementation_type.c_str(), T::implType()) != 0)
            return nullptr;
        if (!validateAndLogPins(ac, T::blueprint()))
            return nullptr;
        logSupportedTraits(T::supportedTraits());
        return new T(ac.mqtt_action_name, ac.pins);
    }

    template <typename T> DeviceAction* tryCreateTel(const ActionConfig& ac, int interval)
    {
        if (strcmp(ac.implementation_type.c_str(), T::implType()) != 0)
            return nullptr;
        if (!validateAndLogPins(ac, T::blueprint()))
            return nullptr;
        logSupportedTraits(T::supportedTraits());
        return new T(ac.mqtt_action_name, ac.pins, interval);
    }

    DeviceAction* createCommandAction(const ActionConfig& ac)
    {
        LOG_I("Config", "command action '%s' (%s):", ac.mqtt_action_name.c_str(), ac.implementation_type.c_str());

        if (auto* a = tryCreateCmd<OutletCommandAction>(ac))
            return a;
        if (auto* a = tryCreateCmd<OneDirectionalMotorAction>(ac))
            return a;
        if (auto* a = tryCreateCmd<LightDimmerAction>(ac))
            return a;
        if (auto* a = tryCreateCmd<PwmOutputAction>(ac))
            return a;
        if (auto* a = tryCreateCmd<I2cSocket8Action>(ac))
            return a;
        if (auto* a = tryCreateCmd<I2cSocket16Action>(ac))
            return a;

        LOG_W("Config", "unknown command type: %s", ac.implementation_type.c_str());
        return nullptr;
    }

    DeviceAction* createTelemetryAction(const ActionConfig& ac)
    {
        int interval = ac.telemetry_interval_ms > 0 ? ac.telemetry_interval_ms : READING_INTERVAL;
        LOG_I("Config", "telemetry action '%s' (%s), interval: %d ms:", ac.mqtt_action_name.c_str(),
              ac.implementation_type.c_str(), interval);

        if (auto* a = tryCreateTel<TemperatureAction>(ac, interval))
            return a;
        if (auto* a = tryCreateTel<WaterLevelAction>(ac, interval))
            return a;
        if (auto* a = tryCreateTel<PhLevelAction>(ac, interval))
            return a;
        if (auto* a = tryCreateTel<TdsLevelAction>(ac, interval))
            return a;
        if (auto* a = tryCreateTel<HumidityAction>(ac, interval))
            return a;
        if (auto* a = tryCreateTel<AirTemperatureAction>(ac, interval))
            return a;
        if (auto* a = tryCreateTel<CO2LevelAction>(ac, interval))
            return a;
#ifdef HAS_CAMERA
        // Not routed through tryCreateTel<T> — CameraAction needs a post-construction
        // configure() call for its per-instance resolution/transport, which the generic
        // (name, pins, interval) constructor signature has no room for.
        if (strcmp(ac.implementation_type.c_str(), CameraAction::implType()) == 0)
        {
            if (!validateAndLogPins(ac, CameraAction::blueprint()))
                return nullptr;
            logSupportedTraits(CameraAction::supportedTraits());
            auto* a = new CameraAction(ac.mqtt_action_name, ac.pins, interval);
            a->configure(ac.camera_resolution, ac.camera_transport);
            _cameraAction = a;
            return a;
        }
#endif

        LOG_W("Config", "unknown telemetry type: %s", ac.implementation_type.c_str());
        return nullptr;
    }

  public:
    ~DynamicDeviceActionsService()
    {
        if (_ownedByServer)
        {
            for (auto* a : _actions)
                delete a;
        }
    }

    bool loadFromServer(JwtToken* jwtData)
    {
        if (!jwtData || jwtData->token.isEmpty())
        {
            LOG_E("Config", "no JWT available — cannot load device configuration");
            return false;
        }

        String deviceConfigUrl =
            jwtData->deviceConfigUrl + "?deviceId=" + String(jwtData->deviceId) + "&version=" + String(DEVICE_VERSION);

        if (jwtData->deviceConfigUrl.isEmpty())
        {
            LOG_E("Config", "no device config URL in JWT storage — re-provisioning required");
            return false;
        }

        LOG_I("Config", "fetching device config from: %s", deviceConfigUrl.c_str());

        HttpJsonClientService<EmptyJsonModel, DeviceConfigurationResponse> http;
        DeviceConfigurationResponse resp = http.GetJson(deviceConfigUrl, jwtData->token);

        if (!resp.parsed)
        {
            LOG_E("Config", "server response invalid or empty");
            return false;
        }

        _actions.clear();
#ifdef HAS_CAMERA
        _cameraAction = nullptr;
#endif

        // mqtt_action_type is still the catalog's routing term (which factory builds the
        // action); the runtime type is unified DeviceAction* regardless.
        for (const ActionConfig& ac : resp.actions)
        {
            DeviceAction* a = nullptr;
            if (ac.mqtt_action_type == "command")
                a = createCommandAction(ac);
            else if (ac.mqtt_action_type == "telemetry")
                a = createTelemetryAction(ac);
            if (a != nullptr)
            {
                a->setBehaviors(ac.behaviorCommand, ac.behaviorInterval, ac.behaviorOnDemand);
                _actions.push_back(a);
            }
        }

        _ownedByServer = true;
        LOG_I("Config", "loaded %d actions from server", (int)_actions.size());

#ifdef HAS_CAMERA
        // Start whichever transport the one CameraAction instance (if any) is configured for.
        // Both services are cheap to construct unstarted, so it's fine that only one gets a
        // begin() call — the other just sits idle.
        for (const ActionConfig& ac : resp.actions)
        {
            if (ac.mqtt_action_type != "telemetry")
                continue;
            if (strcmp(ac.implementation_type.c_str(), CameraAction::implType()) != 0)
                continue;

            if (ac.camera_transport == "ws")
                cameraWsService.begin(jwtData->wsStreamUrl, jwtData->token, root_ca, "/ws/stream", ac.mqtt_action_name);
            else
                httpFrameService.begin(jwtData->cameraHttpUrl, jwtData->token, root_ca);
            break; // at most one camera per device
        }
#endif

        return true;
    }

    DeviceAction** getActions() { return _actions.data(); }
    size_t         getActionsCount() { return _actions.size(); }

    // Resolve an action by its MQTT name (used by the command/read verb dispatch).
    DeviceAction* getActionByName(const String& name)
    {
        for (auto* a : _actions)
            if (a->actionName == name)
                return a;
        return nullptr;
    }

#ifdef HAS_CAMERA
    // Routes a take_picture command (see main.cpp's MQTT command dispatch) to the device's
    // camera instance, if any. No-op if the device has no camera configured.
    void triggerPictureCapture(const String& commandId)
    {
        if (_cameraAction)
            _cameraAction->triggerCapture(commandId);
        else
            LOG_W("Camera", "take_picture command received but no camera configured");
    }
#endif
};
