#include <Arduino.h>
#include <ArduinoJson.h>
#include "JsonModel.h"
#pragma once

struct RefreashTokenRequest: public JsonModel
{
  String refreshToken;
  void fromJson(JsonVariantConst src) override
  {
    refreshToken = src["refreshToken"] | "";
  }

  void toJson(JsonVariant dst) const override
  {
    dst["refreshToken"] = refreshToken;
  }
};

struct GetLongLivedTokenRequest: public JsonModel
{
  String deviceId;
  String macAddress;
  String deviceType;
  String provisioningToken;
  String version;



  void fromJson(JsonVariantConst src) override
  {
    deviceId = src["deviceId"] | "";
    macAddress = src["macAddress"] | "";
    deviceType = src["deviceType"] | "";
    provisioningToken = src["provisioningToken"] | "";
    version = src["version"] | "";
  }

  void toJson(JsonVariant dst) const override
  {
    dst["deviceId"] = deviceId;
    dst["macAddress"] = macAddress;
    dst["deviceType"] = deviceType;
    dst["provisioningToken"] = provisioningToken;
    dst["version"] = version;
  }
};
