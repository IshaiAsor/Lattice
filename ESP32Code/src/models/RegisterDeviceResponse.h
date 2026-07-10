#include <Arduino.h>
#include <ArduinoJson.h>
#include "JsonModel.h"
#pragma once
struct RegisterDeviceResponse : public JsonModel
{
    String registrationId;
    String mqttToken;
    String finalizeCallbackUrl;

    void fromJson(JsonVariantConst src) override
    {
        registrationId      = src["registrationId"] | "";
        mqttToken           = src["mqttToken"] | "";
        finalizeCallbackUrl = src["finalizeCallbackUrl"] | "";
    }

    void toJson(JsonVariant dst) const override
    {
        dst["registrationId"]      = registrationId;
        dst["mqttToken"]           = mqttToken;
        dst["finalizeCallbackUrl"] = finalizeCallbackUrl;
    }
};

struct FinalizeRegistrationRequest : public JsonModel
{
    String registrationId;

    void fromJson(JsonVariantConst src) override { registrationId = src["registrationId"] | ""; }

    void toJson(JsonVariant dst) const override { dst["registrationId"] = registrationId; }
};
