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
    std::vector<String> valid_literals;
    bool   has_range = false;
    int    range_min = 0;
    int    range_max = 0;
    std::vector<ActionPinsSetup> pins;
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

            // valid_parameters: { "values": [...], "range": {"min":0,"max":100} }
            JsonObjectConst vp = obj["valid_parameters"].as<JsonObjectConst>();
            for (JsonVariantConst v : vp["values"].as<JsonArrayConst>())
                ac.valid_literals.push_back(v.as<String>());
            if (!vp["range"].isNull())
            {
                ac.has_range = true;
                ac.range_min = vp["range"]["min"] | 0;
                ac.range_max = vp["range"]["max"] | 0;
            }

            // pins: [{"pinNumber":4,"pinMode":"OUTPUT"}, ...]
            for (JsonObjectConst pinObj : obj["pins"].as<JsonArrayConst>())
            {
                String mode = pinObj["pinMode"] | "OUTPUT";
                ac.pins.push_back(ActionPinsSetup(
                    pinObj["pinNumber"] | 0,
                    mode == "OUTPUT" ? OUTPUT : INPUT));
            }

            actions.push_back(ac);
        }
        parsed = !actions.empty();
    }

    void toJson(JsonVariant) const override {}
};
