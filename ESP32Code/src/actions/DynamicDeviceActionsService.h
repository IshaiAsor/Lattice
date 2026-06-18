#pragma once
#include <Arduino.h>
#include <vector>
#include "actions/models/ActionConfig.h"
#include "actions/commands/BaseCommandAction.h"
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/commands/OutletCommandAction.h"
#include "actions/commands/OneDirectionalMotor.h"
#include "actions/commands/LightDimmerAction.h"
#include "actions/commands/OnboardLedCommandAction.h"
#include "actions/telemtries/TemperatureAction.h"
#include "actions/telemtries/WaterLevelAction.h"
#include "actions/telemtries/PhLevelAction.h"
#include "actions/telemtries/TdsLevelAction.h"
#include "actions/telemtries/HumidityAction.h"
#include "actions/telemtries/AirTemperatureAction.h"
#include "actions/telemtries/CO2LevelAction.h"
#ifdef HAS_CAMERA
#include "actions/telemtries/TakePictureAction.h"
#include "actions/telemtries/LiveStreamAction.h"
#include "actions/telemtries/TakePictureHttpAction.h"
#include "actions/telemtries/LiveStreamHttpAction.h"
#include "services/LiveStreamService.h"
#include "services/HttpFrameService.h"
extern LiveStreamService liveStreamService;
extern LiveStreamService wsCaptureService;
extern HttpFrameService  httpFrameService;
extern const char       *root_ca;
#endif
#include "services/HttpJsonClientService.h"
#include "services/PreferencesManagerService.h"
#include "config/settings.h"
#ifndef ONBOARD_LED_PIN
#define ONBOARD_LED_PIN 48
#endif
static OnboardLedAction onboardLed("onboardLed", ONBOARD_LED_PIN);

class DynamicDeviceActionsService
{
private:
    std::vector<BaseCommandAction*>   _cmdActions;
    std::vector<BaseTelemetryAction*> _telActions;
    bool _ownedByServer = false;

    // Validates pin count against the class blueprint and logs the named slot mapping.
    bool validateAndLogPins(const ActionConfig& ac, const PinSlotDef* blueprint)
    {
        size_t required = 0;
        while (blueprint[required].key != nullptr) required++;

        if (required == 0)
        {
            Serial.printf("[Config]   (no user-configurable pins — board macros handle GPIO)\n");
            return true;
        }

        if (ac.pins.size() < required)
        {
            Serial.printf("[Config] ERROR: %s '%s' needs %d pin(s), got %d:\n",
                          ac.implementation_type.c_str(), ac.mqtt_action_name.c_str(),
                          (int)required, (int)ac.pins.size());
            for (size_t i = 0; i < required; i++)
            {
                bool present = i < ac.pins.size();
                Serial.printf("[Config]   [%s] %s — %s\n",
                              blueprint[i].key, blueprint[i].label,
                              present ? "OK" : "MISSING");
            }
            return false;
        }

        for (size_t i = 0; i < required; i++)
        {
            Serial.printf("[Config]   [%s] %s → GPIO%d (%s)\n",
                          blueprint[i].key, blueprint[i].label,
                          ac.pins[i].PIN_NUMBER,
                          blueprint[i].mode == OUTPUT ? "OUTPUT" : "INPUT");
        }
        return true;
    }

    // Logs the Google traits that this action class supports.
    void logSupportedTraits(const GoogleTraitDef* traits)
    {
        if (traits == nullptr || traits[0].traitValue == nullptr)
        {
            Serial.printf("[Config]   Supported traits: (none — read-only)\n");
            return;
        }
        String traitList = "";
        for (size_t i = 0; traits[i].traitValue != nullptr; i++)
        {
            if (i > 0) traitList += ", ";
            traitList += traits[i].label;
        }
        Serial.printf("[Config]   Supported traits: %s\n", traitList.c_str());
    }

    template<typename T>
    BaseCommandAction* tryCreateCmd(const ActionConfig& ac)
    {
        if (strcmp(ac.implementation_type.c_str(), T::implType()) != 0) return nullptr;
        if (!validateAndLogPins(ac, T::blueprint())) return nullptr;
        logSupportedTraits(T::supportedTraits());
        return new T(ac.mqtt_action_name, ac.pins);
    }

    template<typename T>
    BaseTelemetryAction* tryCreateTel(const ActionConfig& ac, int interval)
    {
        if (strcmp(ac.implementation_type.c_str(), T::implType()) != 0) return nullptr;
        if (!validateAndLogPins(ac, T::blueprint())) return nullptr;
        logSupportedTraits(T::supportedTraits());
        return new T(ac.mqtt_action_name, ac.pins, interval);
    }

    BaseCommandAction* createCommandAction(const ActionConfig& ac)
    {
        Serial.printf("[Config] Command action '%s' (%s):\n",
                      ac.mqtt_action_name.c_str(), ac.implementation_type.c_str());

        if (auto* a = tryCreateCmd<OutletCommandAction>(ac))       return a;
        if (auto* a = tryCreateCmd<OneDirectionalMotorAction>(ac)) return a;
        if (auto* a = tryCreateCmd<LightDimmerAction>(ac))         return a;

        Serial.println("[Config] Unknown command type: " + ac.implementation_type);
        return nullptr;
    }

    BaseTelemetryAction* createTelemetryAction(const ActionConfig& ac)
    {
        int interval = ac.telemetry_interval_ms > 0 ? ac.telemetry_interval_ms : READING_INTERVAL;
        Serial.printf("[Config] Telemetry action '%s' (%s), interval: %d ms:\n",
                      ac.mqtt_action_name.c_str(), ac.implementation_type.c_str(), interval);

        if (auto* a = tryCreateTel<TemperatureAction>(ac, interval))    return a;
        if (auto* a = tryCreateTel<WaterLevelAction>(ac, interval))     return a;
        if (auto* a = tryCreateTel<PhLevelAction>(ac, interval))        return a;
        if (auto* a = tryCreateTel<TdsLevelAction>(ac, interval))       return a;
        if (auto* a = tryCreateTel<HumidityAction>(ac, interval))       return a;
        if (auto* a = tryCreateTel<AirTemperatureAction>(ac, interval)) return a;
        if (auto* a = tryCreateTel<CO2LevelAction>(ac, interval))       return a;
#ifdef HAS_CAMERA
        if (auto* a = tryCreateTel<TakePictureAction>(ac, interval))     return a;
        if (auto* a = tryCreateTel<LiveStreamAction>(ac, interval))      return a;
        if (auto* a = tryCreateTel<TakePictureHttpAction>(ac, interval)) return a;
        if (auto* a = tryCreateTel<LiveStreamHttpAction>(ac, interval))  return a;
#endif

        Serial.println("[Config] Unknown telemetry type: " + ac.implementation_type);
        return nullptr;
    }

public:
    ~DynamicDeviceActionsService()
    {
        if (_ownedByServer)
        {
            for (auto* a : _cmdActions)  delete a;
            for (auto* a : _telActions)  delete a;
        }
    }

    bool loadFromServer(JwtToken* jwtData)
    {
        if (!jwtData || jwtData->token.isEmpty())
        {
            Serial.println("[Config] No JWT available — cannot load device configuration.");
            return false;
        }

        String deviceConfigUrl = jwtData->deviceConfigUrl + "?deviceId=" + String(jwtData->deviceId) + "&version=" + String(DEVICE_VERSION);

        if (jwtData->deviceConfigUrl.isEmpty())
        {
            Serial.println("[Config] No device config URL in JWT storage — re-provisioning required.");
            return false;
        }

        Serial.println("[Config] Fetching from: " + deviceConfigUrl);

        HttpJsonClientService<EmptyJsonModel, DeviceConfigurationResponse> http;
        DeviceConfigurationResponse resp = http.GetJson(
            deviceConfigUrl, jwtData->token, jwtData->validateCACert);

        if (!resp.parsed)
        {
            Serial.println("[Config] Server response invalid or empty.");
            return false;
        }

        _cmdActions.clear();
        _telActions.clear();

        for (const ActionConfig& ac : resp.actions)
        {
            if (ac.mqtt_action_type == "command")
            {
                BaseCommandAction* a = createCommandAction(ac);
                if (a != nullptr) _cmdActions.push_back(a);
            }
            else if (ac.mqtt_action_type == "telemetry")
            {
                BaseTelemetryAction* a = createTelemetryAction(ac);
                if (a != nullptr) _telActions.push_back(a);
            }
        }

        _ownedByServer = true;
        Serial.printf("[Config] Loaded %d cmd + %d tel actions from server.\n",
            _cmdActions.size(), _telActions.size());

#ifdef HAS_CAMERA
        for (const ActionConfig& ac : resp.actions)
        {
            if (ac.mqtt_action_type != "telemetry") continue;
            if (ac.implementation_type == "LiveStreamAction")
                liveStreamService.begin(jwtData->wsStreamUrl, jwtData->token, jwtData->validateCACert, root_ca, "/ws/stream", ac.mqtt_action_name);
            else if (ac.implementation_type == "TakePictureAction")
                wsCaptureService.begin(jwtData->wsStreamUrl, jwtData->token, jwtData->validateCACert, root_ca, "/ws/capture", ac.mqtt_action_name);
            else if (ac.implementation_type == "TakePictureHttpAction" ||
                     ac.implementation_type == "LiveStreamHttpAction")
                httpFrameService.begin(jwtData->cameraHttpUrl, jwtData->token, jwtData->validateCACert, root_ca);
        }
#endif

        return true;
    }

    BaseCommandAction**   getDeviceActions()        { return _cmdActions.data(); }
    size_t                getDeviceActionsCount()    { return _cmdActions.size(); }
    BaseTelemetryAction** getTelemetryActions()      { return _telActions.data(); }
    size_t                getTelemetryActionsCount() { return _telActions.size(); }

};
