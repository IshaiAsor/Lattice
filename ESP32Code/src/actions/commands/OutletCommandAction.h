#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"
#include "actions/manifest/CapabilityRegistry.h"
#include "config/Log.h"

class OutletCommandAction : public BaseCommandAction
{
  public:
    static const PinSlotDef*     blueprint() { return CapabilityRegistry::outlet().pins; }
    static const char*           googleActionType() { return CapabilityRegistry::outlet().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::outlet().traits; }
    static CapabilityDescriptor  capability() { return CapabilityRegistry::outlet(); }
    static const char*           implType() { return capability().implType; }

  private:
    int outletPinNumber;

  public:
    OutletCommandAction(String name, std::vector<ActionPinsSetup> pins)
        : BaseCommandAction(name, pins, {"1", "0", "on", "off"})
    {
        outletPinNumber = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    void executeValidAction(String action) override
    {
        if (strcmp(action.c_str(), "1") == 0 || strcmp(action.c_str(), "on") == 0)
        {
            digitalWrite(outletPinNumber, HIGH);
            LOG_D("Cmd", "outlet ON");
        }
        else
        {
            digitalWrite(outletPinNumber, LOW);
            LOG_D("Cmd", "outlet OFF");
        }
    }
};
