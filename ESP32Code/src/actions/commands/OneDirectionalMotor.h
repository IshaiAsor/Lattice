#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"
#include "actions/manifest/CapabilityRegistry.h"
#include "config/Log.h"

class OneDirectionalMotorAction : public BaseCommandAction
{
  public:
    static const PinSlotDef*     blueprint() { return CapabilityRegistry::fan().pins; }
    static const char*           googleActionType() { return CapabilityRegistry::fan().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::fan().traits; }
    static CapabilityDescriptor  capability() { return CapabilityRegistry::fan(); }
    static const char*           implType() { return capability().implType; }

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

    void executeValidAction(String action) override
    {
        if (strcmp(action.c_str(), "0") == 0 || strcmp(action.c_str(), "off") == 0)
        {
            digitalWrite(in1PinNumber, LOW);
            digitalWrite(in2PinNumber, LOW);
            analogWrite(pwmPinNumber, 0);
            LOG_D("Cmd", "motor OFF");
        }
        else if (strcmp(action.c_str(), "on") == 0)
        {
            digitalWrite(in1PinNumber, HIGH);
            digitalWrite(in2PinNumber, LOW);
            analogWrite(pwmPinNumber, 255);
            LOG_D("Cmd", "motor ON at full speed");
        }
        else
        {
            int parsedValue = atoi(action.c_str());
            int pwmValue    = map(parsedValue, 0, 100, 0, 255);
            digitalWrite(in1PinNumber, HIGH);
            digitalWrite(in2PinNumber, LOW);
            analogWrite(pwmPinNumber, pwmValue);
            LOG_D("Cmd", "motor ON at %d%% speed", parsedValue);
        }
    }
};
