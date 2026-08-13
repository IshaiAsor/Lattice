#include <Arduino.h>
#include <ArduinoJson.h>
#include "JsonModel.h"
#pragma once

struct RefreashTokenRequest : public JsonModel
{
    String refreshToken;
    void   fromJson(JsonVariantConst src) override { refreshToken = src["refreshToken"] | ""; }

    void toJson(JsonVariant dst) const override { dst["refreshToken"] = refreshToken; }
};
