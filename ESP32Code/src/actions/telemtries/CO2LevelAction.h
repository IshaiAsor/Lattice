#pragma once
#include <vector>
#include <Arduino.h>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/manifest/CapabilityRegistry.h"

class CO2LevelAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint()        { return CapabilityRegistry::co2Level().pins; }
    static const char* googleActionType()       { return CapabilityRegistry::co2Level().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::co2Level().traits; }
    static CapabilityDescriptor capability()    { return CapabilityRegistry::co2Level(); }
    static const char* implType()               { return capability().implType; }

private:
    HardwareSerial _serial;
    int rxPin;
    int txPin;

    // MH-Z19B read CO2 command (9 bytes, checksum = 0x79)
    static const uint8_t CMD_READ[9];

public:
    CO2LevelAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins), _serial(1)
    {
        rxPin = pins.size() > 0 ? pins[0].PIN_NUMBER : 16;
        txPin = pins.size() > 1 ? pins[1].PIN_NUMBER : 17;
    }

    void initPins() override
    {
        _serial.begin(9600, SERIAL_8N1, rxPin, txPin);
        delay(100);
    }

    String executeTelemetryAction() override
    {
        // Flush any pending data
        while (_serial.available()) _serial.read();

        _serial.write(CMD_READ, 9);

        unsigned long start = millis();
        while (_serial.available() < 9 && millis() - start < 500) delay(5);

        if (_serial.available() < 9) {
            Serial.println("CO2 sensor timeout");
            return "";
        }

        uint8_t response[9];
        _serial.readBytes(response, 9);

        if (response[0] != 0xFF || response[1] != 0x86) {
            Serial.println("CO2 sensor bad response header");
            return "";
        }

        int co2 = ((int)response[2] << 8) | response[3];
        Serial.printf("CO2: %d ppm\n", co2);
        return String(co2);
    }
};

const uint8_t CO2LevelAction::CMD_READ[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79};
