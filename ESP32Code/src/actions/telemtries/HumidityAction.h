#pragma once
#include <vector>
#include <Arduino.h>
#include <Wire.h>
#include "actions/telemtries/BaseTelemtryAction.h"

class HumidityAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint() {
        static const PinSlotDef slots[] = {
            { "sda", "I2C SDA (SHT41)", INPUT },
            { "scl", "I2C SCL (SHT41)", INPUT },
            { nullptr }
        };
        return slots;
    }

    static const GoogleTraitDef* supportedTraits() {
        static const GoogleTraitDef traits[] = {
            { "action.devices.traits.HumiditySetting", "HumiditySetting" },
            { nullptr }
        };
        return traits;
    }

private:
    int sdaPin;
    int sclPin;

    // SHT41 I2C address and measure-high-repeatability command
    static constexpr uint8_t SHT41_ADDR = 0x44;
    static constexpr uint8_t SHT41_CMD  = 0xFD;

    bool readSHT41(float &temp, float &hum)
    {
        Wire.beginTransmission(SHT41_ADDR);
        Wire.write(SHT41_CMD);
        if (Wire.endTransmission() != 0) return false;

        delay(10);

        if (Wire.requestFrom((uint8_t)SHT41_ADDR, (uint8_t)6) != 6) return false;

        uint8_t buf[6];
        for (int i = 0; i < 6; i++) buf[i] = Wire.read();

        uint16_t rawT = ((uint16_t)buf[0] << 8) | buf[1];
        uint16_t rawH = ((uint16_t)buf[3] << 8) | buf[4];

        temp = -45.0f + 175.0f * (rawT / 65535.0f);
        hum  =  -6.0f + 125.0f * (rawH / 65535.0f);
        hum  = constrain(hum, 0.0f, 100.0f);
        return true;
    }

public:
    HumidityAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        sdaPin = pins.size() > 0 ? pins[0].PIN_NUMBER : SDA;
        sclPin = pins.size() > 1 ? pins[1].PIN_NUMBER : SCL;
    }

    void initPins() override
    {
        Wire.begin(sdaPin, sclPin);
    }

    String executeTelemetryAction() override
    {
        float temp, hum;
        if (!readSHT41(temp, hum)) {
            Serial.println("SHT41 read failed (humidity)");
            return "";
        }
        Serial.printf("Humidity: %.1f%%\n", hum);
        return String(hum, 1);
    }
};
