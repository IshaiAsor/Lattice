#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"

class OneDirectionalMotorAction : public BaseCommandAction
{
private:
    int in1PinNumber;
    int in2PinNumber;
    int pwmPinNumber;

public:
    // Static / fallback constructor
    OneDirectionalMotorAction(String name, int in1Pin, int in2Pin, int pwmPin)
        : BaseCommandAction(name,
                            {ActionPinsSetup(in1Pin, OUTPUT),
                             ActionPinsSetup(in2Pin, OUTPUT),
                             ActionPinsSetup(pwmPin, OUTPUT)},
                            {"off", "on"})
    {
        in1PinNumber = in1Pin;
        in2PinNumber = in2Pin;
        pwmPinNumber = pwmPin;
    }

    // Dynamic constructor — pins, literals, and numeric range from server
    OneDirectionalMotorAction(String name, std::vector<ActionPinsSetup> pins,
                              std::vector<std::string> literals, bool useRange, int rMin, int rMax)
        : BaseCommandAction(name, pins, literals, useRange, rMin, rMax)
    {
        in1PinNumber = pins.size() > 0 ? pins[0].PIN_NUMBER : 0;
        in2PinNumber = pins.size() > 1 ? pins[1].PIN_NUMBER : 0;
        pwmPinNumber = pins.size() > 2 ? pins[2].PIN_NUMBER : 0;
    }

    void initPins() override
    {
        // Pin modes set by base class; no need to populate validParameters from a loop
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
