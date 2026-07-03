#pragma once
// Canonical Google Smart Home trait definitions — the single place each trait's identity,
// display label, and accepted-value constraint are declared. CapabilityRegistry.h composes
// these per capability; the constraint travels through the manifest (CapabilitySerializer.h)
// into google_device_traits.valid_parameters, so seed-catalog.ts reads it instead of
// guessing it from a hardcoded backend-side table.
#include "actions/ActionPinsSetup.h"

namespace GoogleTraits {

inline const GoogleTraitDef& OnOff() {
    static const char* const values[] = { "on", "off", nullptr };
    static const GoogleTraitDef def = {
        "action.devices.traits.OnOff", "OnOff", TraitConstraintType::Enum, values, 0, 0, 0
    };
    return def;
}

inline const GoogleTraitDef& Brightness() {
    static const GoogleTraitDef def = {
        "action.devices.traits.Brightness", "Brightness", TraitConstraintType::Range, nullptr, 0, 100, 1
    };
    return def;
}

inline const GoogleTraitDef& FanSpeed() {
    static const GoogleTraitDef def = {
        "action.devices.traits.FanSpeed", "FanSpeed", TraitConstraintType::Range, nullptr, 0, 100, 1
    };
    return def;
}

inline const GoogleTraitDef& TemperatureSetting() {
    static const GoogleTraitDef def = {
        "action.devices.traits.TemperatureSetting", "TemperatureSetting", TraitConstraintType::None, nullptr, 0, 0, 0
    };
    return def;
}

inline const GoogleTraitDef& HumiditySetting() {
    static const GoogleTraitDef def = {
        "action.devices.traits.HumiditySetting", "HumiditySetting", TraitConstraintType::None, nullptr, 0, 0, 0
    };
    return def;
}

inline const GoogleTraitDef& WaterLevel() {
    static const GoogleTraitDef def = {
        "action.devices.traits.WaterLevel", "WaterLevel", TraitConstraintType::None, nullptr, 0, 0, 0
    };
    return def;
}

inline const GoogleTraitDef& PhLevel() {
    static const GoogleTraitDef def = {
        "action.devices.traits.PhLevel", "PhLevel", TraitConstraintType::None, nullptr, 0, 0, 0
    };
    return def;
}

inline const GoogleTraitDef& TdsLevel() {
    static const GoogleTraitDef def = {
        "action.devices.traits.TdsLevel", "TdsLevel", TraitConstraintType::None, nullptr, 0, 0, 0
    };
    return def;
}

inline const GoogleTraitDef& CO2Level() {
    static const GoogleTraitDef def = {
        "action.devices.traits.CO2Level", "CO2Level", TraitConstraintType::None, nullptr, 0, 0, 0
    };
    return def;
}

inline const GoogleTraitDef& CameraStream() {
    static const GoogleTraitDef def = {
        "action.devices.traits.CameraStream", "CameraStream", TraitConstraintType::None, nullptr, 0, 0, 0
    };
    return def;
}

}  // namespace GoogleTraits
