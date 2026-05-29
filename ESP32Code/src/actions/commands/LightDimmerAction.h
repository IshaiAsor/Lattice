#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"

class LightDimmerAction : public BaseCommandAction
{
private:
    int dimmerPinNumber;

public:
    // Static / fallback constructor
    LightDimmerAction(String name, int dimmerPin)
        : BaseCommandAction(name,
                            {ActionPinsSetup(dimmerPin, OUTPUT)},
                            {"off", "on"})
    {
        dimmerPinNumber = dimmerPin;
    }

    // Dynamic constructor — pins, literals, and numeric range from server
    LightDimmerAction(String name, std::vector<ActionPinsSetup> pins,
                      std::vector<std::string> literals, bool useRange, int rMin, int rMax)
        : BaseCommandAction(name, pins, literals, useRange, rMin, rMax)
    {
        dimmerPinNumber = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    void initPins() override
    {
        // Pin modes set by base class; no loop needed — validParameters from server
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
