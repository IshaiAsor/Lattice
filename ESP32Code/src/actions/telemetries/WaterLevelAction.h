#pragma once
#include <vector>
#include <Arduino.h>
#include "actions/telemetries/BaseTelemetryAction.h"
#include "actions/manifest/CapabilityRegistry.h"
#include "config/Log.h"

class WaterLevelAction : public BaseTelemetryAction
{
  public:
    static const PinSlotDef*     blueprint() { return CapabilityRegistry::waterLevel().pins; }
    static const char*           googleActionType() { return CapabilityRegistry::waterLevel().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::waterLevel().traits; }
    static CapabilityDescriptor  capability() { return CapabilityRegistry::waterLevel(); }
    static const char*           implType() { return capability().implType; }

  private:
    int sensorPin;

  public:
    WaterLevelAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        sensorPin = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    String executeTelemetryAction() override
    {
        int raw = analogRead(sensorPin);
        if (raw < 0 || raw > 4095)
            return "";
        float pct = (raw / 4095.0f) * 100.0f;
        LOG_D("Sensor", "water level: %.1f%%", pct);
        return String(pct, 1);
    }
};
