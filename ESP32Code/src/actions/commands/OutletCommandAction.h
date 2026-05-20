
#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include ".\BaseCommandAction.h"


class OutletCommandAction : public BaseCommandAction
{
private:
    int outletPinNumber;

public:
    OutletCommandAction(String name, int pinNumber)
        : BaseCommandAction(name, {ActionPinsSetup(pinNumber, OUTPUT)}, {"on", "off"})
    {
        outletPinNumber = pinNumber;
    }
    void initPins()
    {
    }
    void executeValidAction(String action) override
    {
        if (strcmp(action.c_str(), "on") == 0)
        {
            digitalWrite(outletPinNumber, HIGH);
            Serial.println("Outlet ON");
        }
        else if (strcmp(action.c_str(), "off") == 0)
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

