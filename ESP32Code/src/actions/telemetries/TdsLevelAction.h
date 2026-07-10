#pragma once
#include <vector>
#include <Arduino.h>
#include "actions/telemetries/BaseTelemetryAction.h"
#include "actions/manifest/CapabilityRegistry.h"
#include "config/Log.h"

class TdsLevelAction : public BaseTelemetryAction
{
  public:
    static const PinSlotDef*     blueprint() { return CapabilityRegistry::tdsLevel().pins; }
    static const char*           googleActionType() { return CapabilityRegistry::tdsLevel().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::tdsLevel().traits; }
    static CapabilityDescriptor  capability() { return CapabilityRegistry::tdsLevel(); }
    static const char*           implType() { return capability().implType; }

  private:
    int sensorPin;

  public:
    TdsLevelAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        sensorPin = pins.empty() ? 0 : pins[0].PIN_NUMBER;
    }

    String executeTelemetryAction() override
    {
        int raw = analogRead(sensorPin);
        if (raw < 0 || raw > 4095)
            return "";
        float tds = (raw / 4095.0f) * 1000.0f;
        LOG_D("Sensor", "TDS: %.1f ppm", tds);
        return String(tds, 1);
    }
};
