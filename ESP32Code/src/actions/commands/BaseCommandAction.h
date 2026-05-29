#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "services/PreferencesManagerService.h"
#include <actions/ActionPinsSetup.h>

class BaseCommandAction
{
protected:
    bool hasRange = false;
    int  rangeMin = 0;
    int  rangeMax = 0;

    bool validateActionPayload(String action)
    {
        for (int i = 0; i < validParameters.size(); i++)
        {
            if (strcmp(action.c_str(), validParameters[i].c_str()) == 0)
            {
                return true;
            }
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

    virtual void loadState()
    {
        String lastState = prefService.LoadActionState((char *)actionName.c_str());
        if (lastState != nullptr)
        {
            execute(lastState);
        }
    }

    virtual void executeValidAction(String action) = 0;

private:
    PreferencesManagerService prefService;

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
    virtual void loop() {}

public:
    virtual void initPins()
    {
        for (int i = 0; i < actionPinsSetup.size(); i++)
        {
            pinMode(actionPinsSetup[i].PIN_NUMBER, actionPinsSetup[i].PIN_MODE);
            Serial.println("Pin " + String(actionPinsSetup[i].PIN_NUMBER) + " set to " + String(actionPinsSetup[i].PIN_MODE));
        }
    }

    virtual void execute(String action)
    {
        if (validateActionPayload(action))
        {
            Serial.println("Executing valid action: " + action);
            executeValidAction(action);
            state = action;
            prefService.SaveActionState((char *)actionName.c_str(), (char *)action.c_str());
        }
        else
        {
            Serial.println("Invalid parameter : " + action);
        }
    }

protected:
    String state;
};
