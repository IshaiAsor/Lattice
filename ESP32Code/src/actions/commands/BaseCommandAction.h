#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include <ArduinoJson.h>
#include "services/PreferencesManagerService.h"
#include <actions/ActionPinsSetup.h>

class BaseCommandAction
{
protected:
    bool hasRange = false;
    int  rangeMin = 0;
    int  rangeMax = 0;

    int32_t       _durationMs     = -1;
    unsigned long _durationStart  = 0;
    bool          _durationActive = false;

    String state;

    bool validateActionPayload(String action)
    {
        for (int i = 0; i < validParameters.size(); i++)
        {
            if (strcmp(action.c_str(), validParameters[i].c_str()) == 0)
                return true;
        }
        if (hasRange)
        {
            bool isNum = action.length() > 0;
            for (unsigned int i = 0; i < action.length(); i++)
            {
                if (!isdigit(action[i]) && !(i == 0 && action[i] == '-'))
                {
                    isNum = false;
                    break;
                }
            }
            if (isNum)
            {
                int val = action.toInt();
                if (val >= rangeMin && val <= rangeMax)
                    return true;
            }
        }
        return false;
    }

    // Validates, executes, saves state, and arms the duration timer.
    void applyAction(String action, int32_t durationMs = -1)
    {
        if (validateActionPayload(action))
        {
            Serial.println("Executing valid action: " + action);
            executeValidAction(action);
            state = action;
            ActionState newState(actionName, state);
            prefService.SaveActionState(newState);
            if (durationMs > 0)
            {
                _durationMs    = durationMs;
                _durationStart = millis();
                _durationActive = true;
            }
            else
            {
                _durationActive = false;
            }
        }
        else
        {
            Serial.println("Invalid parameter: " + action);
        }
    }

    virtual void executeValidAction(String action) = 0;

public:
    String actionName;
    std::vector<ActionPinsSetup> actionPinsSetup;
    std::vector<std::string> validParameters;

    BaseCommandAction(String name, std::vector<ActionPinsSetup> pinsSetup, std::vector<std::string> validParams)
    {
        actionName = name;
        actionPinsSetup = pinsSetup;
        validParameters = validParams;
    }

    BaseCommandAction(String name, std::vector<ActionPinsSetup> pinsSetup, std::vector<std::string> validParams,
                      bool useRange, int rMin, int rMax)
    {
        actionName = name;
        actionPinsSetup = pinsSetup;
        validParameters = validParams;
        hasRange = useRange;
        rangeMin = rMin;
        rangeMax = rMax;
    }

    virtual ~BaseCommandAction() {}

    // Restores the last saved state from NVS. Call once after initPins() on boot.
    void loadState()
    {
        ActionState *lastState = prefService.LoadActionState();
        if (lastState)
        {
            applyAction(lastState->state);
            delete lastState;
        }
    }

    // Fires auto-off when the duration timer expires.
    virtual void loop()
    {
        if (_durationActive &&
            (millis() - _durationStart) >= (unsigned long)_durationMs)
        {
            _durationActive = false;
            applyAction("off");
        }
    }

    virtual void initPins()
    {
        for (int i = 0; i < actionPinsSetup.size(); i++)
        {
            pinMode(actionPinsSetup[i].PIN_NUMBER, actionPinsSetup[i].PIN_MODE);
            Serial.println("Pin " + String(actionPinsSetup[i].PIN_NUMBER) + " set to " + String(actionPinsSetup[i].PIN_MODE));
        }
    }

    // Parses JSON payload {"value":"on","duration":30} sent from the backend.
    // Duration "*" or absent means no auto-off. Falls back to plain string for internal calls.
    virtual void execute(String payload)
    {
        JsonDocument doc;
        DeserializationError err = deserializeJson(doc, payload);

        String action;
        int32_t durationMs = -1;

        if (!err && !doc["value"].isNull())
        {
            action = doc["value"].as<String>();
            JsonVariant dur = doc["duration"];
            if (!dur.isNull() && strcmp(dur.as<const char *>(), "*") != 0)
                durationMs = (int32_t)(dur.as<float>() * 1000.0f);
        }
        else
        {
            action = payload;
        }

        applyAction(action, durationMs);
    }
};
