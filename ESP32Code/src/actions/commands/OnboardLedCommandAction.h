
#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include "BaseCommandAction.h"
#include <Adafruit_NeoPixel.h>

class OnboardLedAction : public BaseCommandAction
{
private:
    int outletPinNumber;
    Adafruit_NeoPixel strip;
    long lastOnTime = 0;
    long lastOffTime = 0;
    long blinkTime = 500;
    bool isOn = false;

public:
    OnboardLedAction(String name, int pinNumber)
        : BaseCommandAction(name, {ActionPinsSetup(pinNumber, OUTPUT)}, {"red", "green", "blue", "orange", "off"})
    {
        outletPinNumber = pinNumber;
        strip = Adafruit_NeoPixel(1, outletPinNumber, NEO_GRB + NEO_KHZ800);
        strip.begin();
        strip.clear();
    }
    void initPins()
    {
    }

    void loop() override
    {
        long currentTime = millis();
        if (strcmp(state.c_str(), "off") != 0)
        {
            if (isOn)
            {
                lastOnTime = currentTime;
                if (currentTime - lastOffTime > blinkTime)
                {
                    strip.clear();
                    strip.show();
                    isOn = false;
                }
            }
            else
            {
                lastOffTime = currentTime;
                if (currentTime - lastOnTime > blinkTime)
                {
                    executeValidAction(state);
                    isOn = true;
                }
            }
        }
    }

    void executeValidAction(String action) override
    {
        if (strcmp(action.c_str(), "red") == 0)
        {
            strip.setPixelColor(0, strip.Color(255, 0, 0));
            strip.show();
        }
        else if (strcmp(action.c_str(), "green") == 0)
        {
            strip.setPixelColor(0, strip.Color(0, 255, 0));
            strip.show();
        }
        else if (strcmp(action.c_str(), "blue") == 0)
        {
            strip.setPixelColor(0, strip.Color(0, 0, 255));
            strip.show();
        }
        else if (strcmp(action.c_str(), "orange") == 0)
        {
            strip.setPixelColor(0, strip.Color(255, 165, 0));
            strip.show();
        }
        else if (strcmp(action.c_str(), "off") == 0)
        {
            strip.clear();
            strip.show();
        }
        else
        {
            Serial.println("Invalid parameter :" + action);
            return;
        }
    }
};
