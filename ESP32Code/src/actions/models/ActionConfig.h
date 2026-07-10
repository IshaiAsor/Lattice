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
    String                       mqtt_action_name;
    String                       implementation_type;
    String                       mqtt_action_type;
    std::vector<ActionPinsSetup> pins;
    int                          telemetry_interval_ms = 0; // 0 = not set, use firmware default
    // CameraAction only — empty for every other implementation_type.
    String camera_resolution; // e.g. "VGA"/"SVGA"/"XGA"; empty = firmware default
    String camera_transport;  // "ws" or "http"; empty = "http"
    // Enabled behaviors (unified action model). Default all-true; overridden by the served
    // `behaviors` list so a sensor can be interval-only, on-demand-only, or both.
    bool behaviorCommand  = true;
    bool behaviorInterval = true;
    bool behaviorOnDemand = true;
};

class DeviceConfigurationResponse : public JsonModel
{
  public:
    std::vector<ActionConfig> actions;
    bool                      parsed = false;

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
                ac.pins.push_back(ActionPinsSetup(pinObj["pinNumber"] | 0, mode == "OUTPUT" ? OUTPUT : INPUT));
            }

            ac.telemetry_interval_ms = obj["telemetry_interval_ms"] | 0;
            ac.camera_resolution     = obj["camera_resolution"] | "";
            ac.camera_transport      = obj["camera_transport"] | "";

            // behaviors: [{"behavior":"interval","interval_ms":15000},
            //             {"behavior":"on_demand","camera_resolution":"SVGA","camera_transport":"http"}]
            // When present, it is authoritative for which surfaces run; its per-behavior values
            // override the legacy top-level fields. Absent (older gateway) → keep all-true defaults.
            JsonArrayConst behaviors = obj["behaviors"].as<JsonArrayConst>();
            if (!behaviors.isNull())
            {
                ac.behaviorCommand  = false;
                ac.behaviorInterval = false;
                ac.behaviorOnDemand = false;
                for (JsonObjectConst b : behaviors)
                {
                    String bh = b["behavior"] | "";
                    if (bh == "command")
                        ac.behaviorCommand = true;
                    else if (bh == "interval")
                    {
                        ac.behaviorInterval = true;
                        int iv              = b["interval_ms"] | 0;
                        if (iv > 0)
                            ac.telemetry_interval_ms = iv;
                    }
                    else if (bh == "on_demand")
                    {
                        ac.behaviorOnDemand = true;
                        String res          = b["camera_resolution"] | "";
                        String tr           = b["camera_transport"] | "";
                        if (res.length() > 0)
                            ac.camera_resolution = res;
                        if (tr.length() > 0)
                            ac.camera_transport = tr;
                    }
                }
            }

            actions.push_back(ac);
        }
        parsed = src["actions"].is<JsonArrayConst>(); // empty array is valid "no actions configured"
    }

    void toJson(JsonVariant) const override {}
};
