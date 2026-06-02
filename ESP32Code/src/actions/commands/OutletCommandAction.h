#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"

class OutletCommandAction : public BaseCommandAction
{
public:
    static const PinSlotDef* blueprint() {
        static const PinSlotDef slots[] = {
            { "relay", "Relay", OUTPUT },
            { nullptr }
        };
        return slots;
    }

    static const GoogleTraitDef* supportedTraits() {
        static const GoogleTraitDef traits[] = {
            { "action.devices.traits.OnOff",     "OnOff"     },
            { "action.devices.traits.LockUnlock", "LockUnlock" },
            { "action.devices.traits.StartStop",  "StartStop"  },
            { "action.devices.traits.OpenClose",  "OpenClose"  },
            { nullptr }
        };
        return traits;
    }

private:
    int outletPinNumber;

public:
    OutletCommandAction(String name, std::vector<ActionPinsSetup> pins)
        : BaseCommandAction(name, pins, {"1", "0", "on", "off"})
    {
        outletPinNumber = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    void initPins() override {}

    void executeValidAction(String action) override
    {
        if (strcmp(action.c_str(), "1") == 0 || strcmp(action.c_str(), "on") == 0)
        {
            digitalWrite(outletPinNumber, HIGH);
            Serial.println("Outlet ON");
        }
        else
        {
            digitalWrite(outletPinNumber, LOW);
            Serial.println("Outlet OFF");
        }
    }
};
