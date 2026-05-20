
#include <Arduino.h>
#include <ArduinoJson.h>
#include "JsonModel.h"
#pragma once
struct GetLongLivedTokenResponse : public JsonModel
{
  uint32_t deviceId;
  String mqttToken;
  String refreshToken;
  uint32_t jwtExpiry;
  String refreshTokenCallbackUrl;
  bool validateCACert;

  void fromJson(JsonVariantConst src) override
  {
    deviceId = src["deviceId"] | 0;
    mqttToken = src["mqttToken"] | "";
    jwtExpiry = src["jwtExpiry"] | 0;
    refreshToken = src["refreshToken"] | "";
    refreshTokenCallbackUrl = src["refreshTokenCallbackUrl"] | "";
    validateCACert = src["validateCACert"] | false;
  }

  void toJson(JsonVariant dst) const override
  {
    dst["deviceId"] = deviceId;
    dst["token"] = mqttToken;
    dst["jwtExpiry"] = jwtExpiry;
    dst["refreshToken"] = refreshToken;
    dst["refreshTokenCallbackUrl"] = refreshTokenCallbackUrl;
    dst["validateCACert"] = validateCACert;
  }
};