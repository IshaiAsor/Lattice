#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"
#include "actions/manifest/CapabilityRegistry.h"

class LightDimmerAction : public BaseCommandAction
{
public:
    static const PinSlotDef* blueprint()        { return CapabilityRegistry::dimmer().pins; }
    static const char* googleActionType()       { return CapabilityRegistry::dimmer().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::dimmer().traits; }
    static CapabilityDescriptor capability()    { return CapabilityRegistry::dimmer(); }
    static const char* implType()               { return capability().implType; }

private:
    int dimmerPinNumber;

public:
    LightDimmerAction(String name, std::vector<ActionPinsSetup> pins)
        : BaseCommandAction(name, pins, {"off", "on"}, true, 0, 100)
    {
        dimmerPinNumber = pins.empty() ? 0 : pins[0].PIN_NUMBER;
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
