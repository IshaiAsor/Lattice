#pragma once
#include <Arduino.h>
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "PreferencesManagerService.h"
#include "HttpJsonClientService.h"
#include "models/FinalizeRegistration.h"
#include <WiFi.h>
#include "config/settings.h"
#include "models/ProvisioningData.h"
#include <iostream>
#include <chrono>
#include "mbedtls/base64.h"

class DeviceRegistrationService
{
private:
    const char *deviceType = DEVICE_TYPE;
    JwtToken *jwtData;
    uint32_t tokenExp = 0;

public:
    DeviceRegistrationService() {}
    ~DeviceRegistrationService() {}

#include <ArduinoJson.h>
#include <actions/DynamicDeviceActionsService.h>

    bool FinalizeRegistration(ProvisioningData &pData)
    {
        FinalizeRegistrationRequest request;
        request.deviceId = GetDeviceUniqueId();
        request.macAddress = WiFi.macAddress();
        request.deviceType = deviceType;
        request.version = DEVICE_VERSION;
        request.provisioningClientId = pData.clientId;
        String capJson;
        {
            JsonDocument capDoc;
            DynamicDeviceActionsService::serializeCapabilities(capDoc.to<JsonArray>());
            serializeJson(capDoc, capJson);
        } // capDoc destroyed here — its heap pool returned before the POST

        request.capabilitiesJson = capJson;

        HttpJsonClientService<FinalizeRegistrationRequest, FinalizeRegistrationResponse> finalizeHttpClient;
        FinalizeRegistrationResponse response = finalizeHttpClient.PostJson(pData.finalizeCallbackUrl, pData.provisioningToken, &request, pData.validateCACert);

        if (response.permanentToken == "")
        {
            Serial.println("Failed to finalize registration.");
            return false;
        }

        Serial.println("Permanent MQTT token received:");
        Serial.println(response.permanentToken);

        jwtData = new JwtToken();
        jwtData->token = response.permanentToken;
        jwtData->refreshToken = response.refreshToken;
        jwtData->refreshTokenCallbackUrl = response.refreshTokenCallbackUrl;
        jwtData->validateCACert = pData.validateCACert;
        prefService.SaveJwtToken(*jwtData);
        Serial.println("Permanent JWT token stored successfully.");

        MqttCredentials mqttCreds;
        mqttCreds.server = pData.mqttServer;
        mqttCreds.port = pData.mqttPort;
        mqttCreds.clientId = response.clientId;
        mqttCreds.userId = pData.userId;
        mqttCreds.validateCACert = pData.validateCACert;
        prefService.SaveMqttCredentials(mqttCreds);
        Serial.println("MQTT credentials saved successfully.");

        DeviceConfig deviceConfig;
        deviceConfig.deviceConfigUrl = response.deviceConfigUrl;
        deviceConfig.wsStreamUrl = response.wsStreamUrl;
        deviceConfig.cameraHttpUrl = response.cameraHttpUrl;
        prefService.SaveDeviceConfig(deviceConfig);

        Serial.println("Device configuration saved successfully.");
        return true;
    }

    String GetDeviceUniqueId()
    {
        char deviceID[13];
        uint64_t mac = ESP.getEfuseMac();
        snprintf(deviceID, sizeof(deviceID), "%012llX", mac);
        Serial.print("Device ID: ");
        Serial.println(deviceID);
        return String(deviceID);
    }
};

// Global instance declaration
extern DeviceRegistrationService deviceRegistrationService;
