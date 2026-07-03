#pragma once
// Shared capability → JSON serialization. Used by ProvisionRequest (device HTTP POST) and
// by the host manifest generator (tools/manifest-gen) so both emit byte-identical JSON —
// the field contract the backend catalog ingest consumes lives here, in one place.
#include <ArduinoJson.h>
#include "actions/ActionPinsSetup.h"

inline void serializeCapability(JsonArray caps, const CapabilityDescriptor& d) {
    JsonObject cap = caps.add<JsonObject>();
    cap["capability_key"]            = d.key;
    cap["label"]                     = d.label;
    cap["implementation_type"]       = d.implType;
    cap["mqtt_action_type"]          = d.mqttType;
    cap["mqtt_action_name"]          = d.mqttName;
    cap["google_action_type"]        = d.googleType;
    cap["min_telemetry_interval_ms"] = d.minIntervalMs;
    JsonArray tr = cap["google_traits"].to<JsonArray>();
    for (const GoogleTraitDef* t = d.traits; t->traitValue != nullptr; ++t) {
        JsonObject trait = tr.add<JsonObject>();
        trait["value"] = t->traitValue;
        trait["label"] = t->label;
        if (t->constraintType == TraitConstraintType::Enum) {
            JsonObject constraint = trait["constraint"].to<JsonObject>();
            constraint["type"] = "enum";
            JsonArray values = constraint["values"].to<JsonArray>();
            for (const char* const* v = t->enumValues; *v != nullptr; ++v)
                values.add(*v);
        } else if (t->constraintType == TraitConstraintType::Range) {
            JsonObject constraint = trait["constraint"].to<JsonObject>();
            constraint["type"] = "range";
            constraint["min"]  = t->rangeMin;
            constraint["max"]  = t->rangeMax;
            constraint["step"] = t->rangeStep;
        }
    }
    JsonArray pinSlots = cap["configurable_pins"].to<JsonArray>();
    if (d.pins != nullptr) {
        for (const PinSlotDef* p = d.pins; p->key != nullptr; ++p) {
            JsonObject pin = pinSlots.add<JsonObject>();
            pin["key"]   = p->key;
            pin["label"] = p->label;
            pin["mode"]  = (p->mode == OUTPUT) ? "OUTPUT" : "INPUT";
        }
    }
}
