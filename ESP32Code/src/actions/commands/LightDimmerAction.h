#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"

class LightDimmerAction : public BaseCommandAction
{
public:
    static const PinSlotDef* blueprint() {
        static const PinSlotDef slots[] = {
            { "pwm", "PWM", OUTPUT },
            { nullptr }
        };
        return slots;
    }

    static const GoogleTraitDef* supportedTraits() {
        static const GoogleTraitDef traits[] = {
            { "action.devices.traits.OnOff",      "OnOff"      },
            { "action.devices.traits.Brightness",  "Brightness" },
            { nullptr }
        };
        return traits;
    }

private:
    int dimmerPinNumber;

public:
    LightDimmerAction(String name, std::vector<ActionPinsSetup> pins)
        : BaseCommandAction(name, pins, {"off", "on"}, true, 0, 100)
    {
        dimmerPinNumber = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    void initPins() override
    {
        BaseCommandAction::initPins();
    }

    void executeValidAction(String action) override
    {
        if (strcmp(action.c_str(), "0") == 0 || strcmp(action.c_str(), "off") == 0)
        {
            analogWrite(dimmerPinNumber, 0);
            Serial.println("Light OFF");
        }
        else if (strcmp(action.c_str(), "on") == 0)
        {
            analogWrite(dimmerPinNumber, 255);
            Serial.println("Light ON at full brightness");
        }
        else
        {
            int parsedValue = atoi(action.c_str());
            int pwmValue = map(parsedValue, 0, 100, 0, 255);
            analogWrite(dimmerPinNumber, pwmValue);
            Serial.println("Light ON at " + String(parsedValue) + "% brightness");
        }
    }
};
