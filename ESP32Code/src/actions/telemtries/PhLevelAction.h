#pragma once
#include <vector>
#include <Arduino.h>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/manifest/CapabilityRegistry.h"

class PhLevelAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint()        { return CapabilityRegistry::phLevel().pins; }
    static const char* googleActionType()       { return CapabilityRegistry::phLevel().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::phLevel().traits; }
    static CapabilityDescriptor capability()    { return CapabilityRegistry::phLevel(); }
    static const char* implType()               { return capability().implType; }

private:
    int sensorPin;

public:
    PhLevelAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        sensorPin = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    String executeTelemetryAction() override
    {
        int raw = analogRead(sensorPin);
        if (raw < 0 || raw > 4095) return "";
        float ph = (raw / 4095.0f) * 14.0f;
        Serial.printf("pH Level: %.2f\n", ph);
        return String(ph, 2);
    }
};
