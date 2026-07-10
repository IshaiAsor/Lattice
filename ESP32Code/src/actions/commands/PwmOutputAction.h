#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"
#include "actions/manifest/CapabilityRegistry.h"
#include "config/Log.h"

// Generic single-pin PWM output — a raw duty-cycle actuator (0-100%) with "off"/"on"
// shortcuts, not tied to any specific device semantics like the dimmer (LIGHT) or motor
// (FAN). Drives a PWM-capable GPIO via analogWrite, mapping 0-100 → 0-255.
class PwmOutputAction : public BaseCommandAction
{
  public:
    static const PinSlotDef*     blueprint() { return CapabilityRegistry::pwm().pins; }
    static const char*           googleActionType() { return CapabilityRegistry::pwm().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::pwm().traits; }
    static CapabilityDescriptor  capability() { return CapabilityRegistry::pwm(); }
    static const char*           implType() { return capability().implType; }

  private:
    int pwmPinNumber;

  public:
    PwmOutputAction(String name, std::vector<ActionPinsSetup> pins)
        : BaseCommandAction(name, pins, {"off", "on"}, true, 0, 100)
    {
        pwmPinNumber = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    void executeValidAction(String action) override
    {
        if (strcmp(action.c_str(), "0") == 0 || strcmp(action.c_str(), "off") == 0)
        {
            analogWrite(pwmPinNumber, 0);
            LOG_D("Cmd", "PWM OFF");
        }
        else if (strcmp(action.c_str(), "on") == 0)
        {
            analogWrite(pwmPinNumber, 255);
            LOG_D("Cmd", "PWM ON at full duty");
        }
        else
        {
            int parsedValue = atoi(action.c_str());
            int pwmValue    = map(parsedValue, 0, 100, 0, 255);
            analogWrite(pwmPinNumber, pwmValue);
            LOG_D("Cmd", "PWM at %d%% duty", parsedValue);
        }
    }
};
