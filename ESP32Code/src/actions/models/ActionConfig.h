#pragma once
#include <Arduino.h>
#include <vector>
#include <ArduinoJson.h>
#include "models/JsonModel.h"
#include "actions/ActionPinsSetup.h"

// Placeholder satisfying HttpJsonClientService<TIn,TOut> template constraint for GET requests
class EmptyJsonModel : public JsonModel
{
public:
    void fromJson(JsonVariantConst) override {}
    void toJson(JsonVariant) const override {}
};

struct ActionConfig
{
    String mqtt_action_name;
    String implementation_type;
    String mqtt_action_type;
    std::vector<ActionPinsSetup> pins;
    int    telemetry_interval_ms = 0;  // 0 = not set, use firmware default
};

class DeviceConfigurationResponse : public JsonModel
{
public:
    std::vector<ActionConfig> actions;
    bool parsed = false;

    void fromJson(JsonVariantConst src) override
    {
        JsonArrayConst arr = src["actions"].as<JsonArrayConst>();
        for (JsonObjectConst obj : arr)
        {
            ActionConfig ac;
            ac.mqtt_action_name    = obj["mqtt_action_name"] | "";
            ac.implementation_type = obj["implementation_type"] | "";
            ac.mqtt_action_type    = obj["mqtt_action_type"] | "command";

            // pins: [{"pinNumber":4,"pinMode":"OUTPUT"}, ...]
            for (JsonObjectConst pinObj : obj["pins"].as<JsonArrayConst>())
            {
                String mode = pinObj["pinMode"] | "OUTPUT";
                ac.pins.push_back(ActionPinsSetup(
                    pinObj["pinNumber"] | 0,
                    mode == "OUTPUT" ? OUTPUT : INPUT));
            }

            ac.telemetry_interval_ms = obj["telemetry_interval_ms"] | 0;

            actions.push_back(ac);
        }
        parsed = !actions.empty();
    }

    void toJson(JsonVariant) const override {}
};
