#pragma once
#include <vector>
#include <Arduino.h>
#include "actions/telemtries/BaseTelemtryAction.h"

class PhLevelAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint() {
        static const PinSlotDef slots[] = {
            { "adc", "ADC Input", INPUT },
            { nullptr }
        };
        return slots;
    }

    static const GoogleTraitDef* supportedTraits() {
        static const GoogleTraitDef traits[] = {
            { "action.devices.traits.PhLevel", "PhLevel" },
            { nullptr }
        };
        return traits;
    }

private:
    int sensorPin;

public:
    PhLevelAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        sensorPin = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    void initPins() override {}

    String executeTelemetryAction() override
    {
        int raw = analogRead(sensorPin);
        if (raw < 0 || raw > 4095) return "";
        float ph = (raw / 4095.0f) * 14.0f;
        Serial.printf("pH Level: %.2f\n", ph);
        return String(ph, 2);
    }
};
