#pragma once
#include <Arduino.h>

class ActionPinsSetup
{
public:
    int PIN_NUMBER;
    int PIN_MODE;

    ActionPinsSetup(int pinNumber, int pinMode)
    {
        PIN_NUMBER = pinNumber;
        PIN_MODE = pinMode;
    }
};