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

    BaseCommandAction* createCommandAction(const ActionConfig& ac)
    {
        Serial.printf("[Config] Command action '%s' (%s):\n",
                      ac.mqtt_action_name.c_str(), ac.implementation_type.c_str());

        if (ac.implementation_type == "OutletAction")
        {
            if (!validateAndLogPins(ac, OutletCommandAction::blueprint())) return nullptr;
            logSupportedTraits(OutletCommandAction::supportedTraits());
            return new OutletCommandAction(ac.mqtt_action_name, ac.pins);
        }
        if (ac.implementation_type == "OneDirectionalMotorAction")
        {
            if (!validateAndLogPins(ac, OneDirectionalMotorAction::blueprint())) return nullptr;
            logSupportedTraits(OneDirectionalMotorAction::supportedTraits());
            return new OneDirectionalMotorAction(ac.mqtt_action_name, ac.pins);
        }
        if (ac.implementation_type == "LightDimmerAction")
        {
            if (!validateAndLogPins(ac, LightDimmerAction::blueprint())) return nullptr;
            logSupportedTraits(LightDimmerAction::supportedTraits());
            return new LightDimmerAction(ac.mqtt_action_name, ac.pins);
        }
        Serial.println("[Config] Unknown command type: " + ac.implementation_type);
        return nullptr;
    }

    BaseTelemetryAction* createTelemetryAction(const ActionConfig& ac)
    {
        int interval = ac.telemetry_interval_ms > 0 ? ac.telemetry_interval_ms : READING_INTERVAL;
        Serial.printf("[Config] Telemetry action '%s' (%s), interval: %d ms:\n",
                      ac.mqtt_action_name.c_str(), ac.implementation_type.c_str(), interval);

        if (ac.implementation_type == "TemperatureAction")
        {
            if (!validateAndLogPins(ac, TemperatureAction::blueprint())) return nullptr;
            logSupportedTraits(TemperatureAction::supportedTraits());
            return new TemperatureAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "WaterLevelAction")
        {
            if (!validateAndLogPins(ac, WaterLevelAction::blueprint())) return nullptr;
            logSupportedTraits(WaterLevelAction::supportedTraits());
            return new WaterLevelAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "PhLevelAction")
        {
            if (!validateAndLogPins(ac, PhLevelAction::blueprint())) return nullptr;
            logSupportedTraits(PhLevelAction::supportedTraits());
            return new PhLevelAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "TdsLevelAction")
        {
            if (!validateAndLogPins(ac, TdsLevelAction::blueprint())) return nullptr;
            logSupportedTraits(TdsLevelAction::supportedTraits());
            return new TdsLevelAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "HumidityAction")
        {
            if (!validateAndLogPins(ac, HumidityAction::blueprint())) return nullptr;
            logSupportedTraits(HumidityAction::supportedTraits());
            return new HumidityAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "AirTemperatureAction")
        {
            if (!validateAndLogPins(ac, AirTemperatureAction::blueprint())) return nullptr;
            logSupportedTraits(AirTemperatureAction::supportedTraits());
            return new AirTemperatureAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "CO2LevelAction")
        {
            if (!validateAndLogPins(ac, CO2LevelAction::blueprint())) return nullptr;
            logSupportedTraits(CO2LevelAction::supportedTraits());
            return new CO2LevelAction(ac.mqtt_action_name, ac.pins, interval);
        }
#ifdef HAS_CAMERA
        if (ac.implementation_type == "TakePictureAction")
        {
            validateAndLogPins(ac, TakePictureAction::blueprint());
            logSupportedTraits(TakePictureAction::supportedTraits());
            return new TakePictureAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "LiveStreamAction")
        {
            validateAndLogPins(ac, LiveStreamAction::blueprint());
            logSupportedTraits(LiveStreamAction::supportedTraits());
            return new LiveStreamAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "TakePictureHttpAction")
        {
            validateAndLogPins(ac, TakePictureHttpAction::blueprint());
            logSupportedTraits(TakePictureHttpAction::supportedTraits());
            return new TakePictureHttpAction(ac.mqtt_action_name, ac.pins, interval);
        }
        if (ac.implementation_type == "LiveStreamHttpAction")
        {
            validateAndLogPins(ac, LiveStreamHttpAction::blueprint());
            logSupportedTraits(LiveStreamHttpAction::supportedTraits());
            return new LiveStreamHttpAction(ac.mqtt_action_name, ac.pins, interval);
        }
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

        if (jwtData->deviceConfigUrl.isEmpty())
        {
            Serial.println("[Config] No device config URL in JWT storage — re-provisioning required.");
            return false;
        }

        Serial.println("[Config] Fetching from: " + jwtData->deviceConfigUrl);

        HttpJsonClientService<EmptyJsonModel, DeviceConfigurationResponse> http;
        DeviceConfigurationResponse resp = http.GetJson(
            jwtData->deviceConfigUrl, jwtData->token, jwtData->validateCACert);

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

        if (_cmdActions.empty() && _telActions.empty())
        {
            Serial.println("[Config] Factory produced no actions.");
            return false;
        }

        _ownedByServer = true;
        Serial.printf("[Config] Loaded %d cmd + %d tel actions from server.\n",
            _cmdActions.size(), _telActions.size());

#ifdef HAS_CAMERA
        for (const ActionConfig& ac : resp.actions)
        {
            if (ac.mqtt_action_type != "telemetry") continue;
            if (ac.implementation_type == "LiveStreamAction")
                liveStreamService.begin(jwtData->deviceConfigUrl, jwtData->token, jwtData->validateCACert, root_ca);
            else if (ac.implementation_type == "TakePictureAction")
                wsCaptureService.begin(jwtData->deviceConfigUrl, jwtData->token, jwtData->validateCACert, root_ca, "/ws/capture");
            else if (ac.implementation_type == "TakePictureHttpAction" ||
                     ac.implementation_type == "LiveStreamHttpAction")
                httpFrameService.begin(jwtData->deviceConfigUrl, jwtData->token, jwtData->validateCACert, root_ca);
        }
#endif

        return true;
    }

    BaseCommandAction**   getDeviceActions()        { return _cmdActions.data(); }
    size_t                getDeviceActionsCount()    { return _cmdActions.size(); }
    BaseTelemetryAction** getTelemetryActions()      { return _telActions.data(); }
    size_t                getTelemetryActionsCount() { return _telActions.size(); }

};
