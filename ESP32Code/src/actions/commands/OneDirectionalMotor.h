#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"

class OneDirectionalMotorAction : public BaseCommandAction
{
public:
    static const PinSlotDef* blueprint() {
        static const PinSlotDef slots[] = {
            { "in1", "Direction Pin 1 (IN1)", OUTPUT },
            { "in2", "Direction Pin 2 (IN2)", OUTPUT },
            { "pwm", "Speed Pin (PWM)",       OUTPUT },
            { nullptr }
        };
        return slots;
    }

    static const GoogleTraitDef* supportedTraits() {
        static const GoogleTraitDef traits[] = {
            { "action.devices.traits.OnOff",     "OnOff"     },
            { "action.devices.traits.FanSpeed",   "FanSpeed"  },
            { "action.devices.traits.StartStop",  "StartStop" },
            { nullptr }
        };
        return traits;
    }

private:
    int in1PinNumber;
    int in2PinNumber;
    int pwmPinNumber;

public:
    OneDirectionalMotorAction(String name, std::vector<ActionPinsSetup> pins)
        : BaseCommandAction(name, pins, {"off", "on"}, true, 0, 100)
    {
        in1PinNumber = pins.size() > 0 ? pins[0].PIN_NUMBER : 0;
        in2PinNumber = pins.size() > 1 ? pins[1].PIN_NUMBER : 0;
        pwmPinNumber = pins.size() > 2 ? pins[2].PIN_NUMBER : 0;
    }

    void initPins() override
    {
        BaseCommandAction::initPins();
    }

    void executeValidAction(String action) override
    {
        if (strcmp(action.c_str(), "0") == 0 || strcmp(action.c_str(), "off") == 0)
        {
            digitalWrite(in1PinNumber, LOW);
            digitalWrite(in2PinNumber, LOW);
            analogWrite(pwmPinNumber, 0);
            Serial.println("Motor OFF");
        }
        else if (strcmp(action.c_str(), "on") == 0)
        {
            digitalWrite(in1PinNumber, HIGH);
            digitalWrite(in2PinNumber, LOW);
            analogWrite(pwmPinNumber, 255);
            Serial.println("Motor ON at full speed");
        }
        else
        {
            int parsedValue = atoi(action.c_str());
            int pwmValue = map(parsedValue, 0, 100, 0, 255);
            digitalWrite(in1PinNumber, HIGH);
            digitalWrite(in2PinNumber, LOW);
            analogWrite(pwmPinNumber, pwmValue);
            Serial.println("Motor ON at " + String(parsedValue) + "% speed");
        }
    }
};
