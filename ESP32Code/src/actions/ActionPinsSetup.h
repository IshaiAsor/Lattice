#pragma once
#include <Arduino.h>

class ActionPinsSetup
{
public:
    int PIN_NUMBER;
    int PIN_MODE;

    ActionPinsSetup(int pinNumber, int pinMode)
    {
        PIN_NUMBER = pinNumber;
        PIN_MODE = pinMode;
    }
};

// Describes a named pin slot for a specific implementation type.
// Each action class declares a BLUEPRINT[] terminated by a {nullptr} sentinel.
struct PinSlotDef
{
    const char* key;    // logical slot name (e.g. "in1", "relay", "data")
    const char* label;  // human-readable label for serial logging
    int         mode;   // expected pinMode (OUTPUT or INPUT)
};

// Describes a Google Smart Home trait that an action class supports.
// Each action class declares SUPPORTED_TRAITS[] terminated by a {nullptr} sentinel.
struct GoogleTraitDef
{
    const char* traitValue;  // full "action.devices.traits.XXX" string
    const char* label;       // short label for serial logging
};