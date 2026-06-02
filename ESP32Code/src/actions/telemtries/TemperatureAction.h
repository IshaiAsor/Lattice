#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include <services/mqtt.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <functional>
#include "actions/telemtries/BaseTelemtryAction.h"

class TemperatureAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint() {
        static const PinSlotDef slots[] = {
            { "data", "1-Wire Data", INPUT },
            { nullptr }
        };
        return slots;
    }

    static const GoogleTraitDef* supportedTraits() {
        static const GoogleTraitDef traits[] = {
            { "action.devices.traits.TemperatureSetting", "TemperatureSetting" },
            { "action.devices.traits.HumiditySetting",    "HumiditySetting"    },
            { nullptr }
        };
        return traits;
    }

private:
    int pinNumber;
    OneWire oneWire;
    DallasTemperature sensors;

    void initSensor(int pin)
    {
        pinNumber = pin;
        oneWire = OneWire(pin);
        sensors = DallasTemperature(&oneWire);
        sensors.begin();
    }

public:
    // Static / fallback constructor
    TemperatureAction(int pin, String name, int readInterval)
        : BaseTelemetryAction(name, readInterval, {ActionPinsSetup(pin, INPUT)})
    {
        initSensor(pin);
    }

    // Dynamic constructor — pin from server
    TemperatureAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        initSensor(pins.empty() ? 0 : pins[0].PIN_NUMBER);
    }

    void initPins() override {}

    String executeTelemetryAction() override
    {
        sensors.requestTemperatures();
        float tempC = sensors.getTempCByIndex(0);

        if (tempC != DEVICE_DISCONNECTED_C)
        {
            Serial.print("Temperature: ");
            Serial.print(tempC);
            Serial.println("°C");
            return String(tempC);
        }
        else
        {
            Serial.println("Error: Could not read temperature data");
            return "";
        }
    }
};
