
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
private:
    int pinNumber;
    OneWire oneWire;
    DallasTemperature sensors;

public:
    TemperatureAction(int pinNumber, String name, int readInterval)
        : BaseTelemetryAction(name, readInterval, {ActionPinsSetup(pinNumber, INPUT)})
    {
        this->pinNumber = pinNumber;
        oneWire = OneWire(pinNumber);
        sensors = DallasTemperature(&oneWire);
        sensors.begin();
    }

    void initPins() override {};

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