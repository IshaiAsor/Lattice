#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"

class OutletCommandAction : public BaseCommandAction
{
private:
    int outletPinNumber;

public:
    // Static / fallback constructor
    OutletCommandAction(String name, int pinNumber)
        : BaseCommandAction(name, {ActionPinsSetup(pinNumber, OUTPUT)}, {"1", "0", "on", "off"})
    {
        outletPinNumber = pinNumber;
    }

    // Dynamic constructor — pins and valid parameters from server
    OutletCommandAction(String name, std::vector<ActionPinsSetup> pins, std::vector<std::string> literals)
        : BaseCommandAction(name, pins, literals, false, 0, 0)
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
        else if (strcmp(action.c_str(), "0") == 0 || strcmp(action.c_str(), "off") == 0)
        {
            digitalWrite(outletPinNumber, LOW);
            Serial.println("Outlet OFF");
        }
        else
        {
            Serial.println("Invalid parameter :" + action);
        }
    }
};
