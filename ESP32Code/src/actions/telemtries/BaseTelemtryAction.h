
#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include <services/mqtt.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <functional>
#include "services/mqtt.h"

class BaseTelemetryAction
{
protected:
    virtual String executeTelemetryAction() = 0;

public:
    String actionName;
    int actionReadInterval;
    unsigned long lastReadTime = 0;
    std::vector<ActionPinsSetup> actionPinsSetup;
    bool healthy = true;
    String errorMessage = "";
    long lastErrorTime = 0;

    BaseTelemetryAction(String name, int readInterval, std::vector<ActionPinsSetup> pinsSetup)
    {
        actionName = name;
        actionPinsSetup = pinsSetup;
        actionReadInterval = readInterval;
    }   

    virtual ~BaseTelemetryAction() {}

public:
    virtual void initPins()
    {
        for (int i = 0; i < actionPinsSetup.size(); i++)
        {
            pinMode(actionPinsSetup[i].PIN_NUMBER, actionPinsSetup[i].PIN_MODE);
            Serial.println("Pin " + String(actionPinsSetup[i].PIN_NUMBER) + " set to " + String(actionPinsSetup[i].PIN_MODE));
        }
    }

    virtual void execute(unsigned long currentTime, std::function<void(const char *, const char *)> callback)
    {
        if (currentTime - lastReadTime >= actionReadInterval)
        {
            lastReadTime = currentTime;
            Serial.println("Executing telemetry action: " + actionName);
            String msg = executeTelemetryAction();
            if (msg.length() > 0)
            {
                callback(actionName.c_str(), msg.c_str());
                healthy = true;
                errorMessage = "";
                lastErrorTime = 0;
            }
            else
            {
                healthy = false;
                errorMessage = "Unable to read data from sensor : " + actionName;
                lastErrorTime = currentTime;
                Serial.println(errorMessage);
            }
        }
    }
};
