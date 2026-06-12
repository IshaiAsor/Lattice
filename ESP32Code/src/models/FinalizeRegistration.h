#include <Arduino.h>
#include <ArduinoJson.h>
#include "JsonModel.h"
#pragma once

struct FinalizeRegistrationRequest : public JsonModel
{
  String deviceId;
  String macAddress;
  String deviceType;
  String version;
  String capabilitiesJson;
  String provisioningClientId;
  void fromJson(JsonVariantConst src) override
  {
    deviceId = src["deviceId"] | "";
    macAddress = src["macAddress"] | "";
    deviceType = src["deviceType"] | "";
    version = src["version"] | "";
    capabilitiesJson = src["capabilitiesJson"] | "";
    provisioningClientId = src["provisioningClientId"] | "";
   
  }

  void toJson(JsonVariant dst) const override
  {
    dst["deviceId"] = deviceId;
    dst["macAddress"] = macAddress;
    dst["deviceType"] = deviceType;
    dst["version"] = version;
    dst["provisioningClientId"] = provisioningClientId;
    if (capabilitiesJson.length() > 0) {
      JsonDocument capDoc;
      deserializeJson(capDoc, capabilitiesJson);
      dst["capabilities"].set(capDoc.as<JsonVariant>());
    }
  }
};

struct FinalizeRegistrationResponse : public JsonModel
{
  uint32_t clientId;
  String permanentToken;
  String refreshToken;
  String refreshTokenCallbackUrl;
   String wsStreamUrl;
  String cameraHttpUrl;
  String deviceConfigUrl;
  void fromJson(JsonVariantConst src) override
  {
    clientId = src["clientId"] | 0;
    permanentToken = src["permanentToken"] | "";
    refreshToken = src["refreshToken"] | "";
    refreshTokenCallbackUrl = src["refreshTokenCallbackUrl"] | "";
     wsStreamUrl = src["wsStreamUrl"] | "";
    cameraHttpUrl = src["cameraHttpUrl"] | "";
    deviceConfigUrl = src["deviceConfigUrl"] | "";
  }

  void toJson(JsonVariant dst) const override
  {
    dst["clientId"] = clientId;
    dst["permanentToken"] = permanentToken;
    dst["refreshToken"] = refreshToken;
    dst["refreshTokenCallbackUrl"] = refreshTokenCallbackUrl;
    dst["wsStreamUrl"] = wsStreamUrl;
    dst["cameraHttpUrl"] = cameraHttpUrl;
    dst["deviceConfigUrl"] = deviceConfigUrl;
  }
};
