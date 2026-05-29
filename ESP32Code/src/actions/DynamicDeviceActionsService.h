#pragma once
#include <Arduino.h>
#include <vector>
#include "actions/models/ActionConfig.h"
#include "actions/commands/BaseCommandAction.h"
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/commands/OutletCommandAction.h"
#include "actions/commands/OneDirectionalMotor.h"
#include "actions/commands/LightDimmerAction.h"
#include "actions/telemtries/TemperatureAction.h"
#include "services/HttpJsonClientService.h"
#include "services/PreferencesManagerService.h"
#include "config/settings.h"

class DynamicDeviceActionsService
{
private:
    std::vector<BaseCommandAction*>   _cmdActions;
    std::vector<BaseTelemetryAction*> _telActions;
    bool _ownedByServer = false;

    std::vector<std::string> toLiteralVec(const ActionConfig& ac)
    {
        std::vector<std::string> out;
        for (const String& s : ac.valid_literals)
            out.push_back(s.c_str());
        return out;
    }

    BaseCommandAction* createCommandAction(const ActionConfig& ac)
    {
        auto lits = toLiteralVec(ac);
        if (ac.implementation_type == "OutletAction")
            return new OutletCommandAction(ac.mqtt_action_name, ac.pins, lits);
        if (ac.implementation_type == "OneDirectionalMotorAction")
            return new OneDirectionalMotorAction(ac.mqtt_action_name, ac.pins, lits,
                                                 ac.has_range, ac.range_min, ac.range_max);
        if (ac.implementation_type == "LightDimmerAction")
            return new LightDimmerAction(ac.mqtt_action_name, ac.pins, lits,
                                         ac.has_range, ac.range_min, ac.range_max);
        Serial.println("[Config] Unknown command type: " + ac.implementation_type);
        return nullptr;
    }

    BaseTelemetryAction* createTelemetryAction(const ActionConfig& ac)
    {
        if (ac.implementation_type == "TemperatureAction")
            return new TemperatureAction(ac.mqtt_action_name, ac.pins, READING_INTERVAL);
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

    // Returns true if actions loaded from server successfully.
    // Returns false if server unreachable or response invalid — caller must handle (e.g. restart).
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
        return true;
    }

    BaseCommandAction**   getDeviceActions()        { return _cmdActions.data(); }
    size_t                getDeviceActionsCount()    { return _cmdActions.size(); }
    BaseTelemetryAction** getTelemetryActions()      { return _telActions.data(); }
    size_t                getTelemetryActionsCount() { return _telActions.size(); }
};
