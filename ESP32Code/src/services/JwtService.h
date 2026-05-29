#pragma once
#include <Arduino.h>
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "PreferencesManagerService.h"
#include "HttpJsonClientService.h"
#include "models/GetLongLivedTokenRequest.h"
#include "models/GetLongLivedTokenResponse.h"
#include "models/RegisterDeviceResponse.h"
#include <WiFi.h>
#include "config/settings.h"
#include "models/ProvisioningData.h"
// #include <jwt-cpp/jwt.h>
#include <iostream>
#include <chrono>
#include "mbedtls/base64.h"

class JwtService
{
private:
    PreferencesManagerService prefService;
    HttpJsonClientService<GetLongLivedTokenRequest, RegisterDeviceResponse> longLivedTokenHttpClient;
    HttpJsonClientService<RefreashTokenRequest, GetLongLivedTokenResponse> refreashTokenHttpClient;

    const char *deviceType = DEVICE_TYPE;
    JwtToken *jwtData;
    uint32_t tokenExp = 0;

public:
    JwtService() {}
    ~JwtService() {}

#include <ArduinoJson.h>

    bool RefreshJwtTokenIfNeeded()
    {
        if (jwtData == nullptr)
        {
            Serial.println("No JWT token found in storage.");
            return false;
        }
        else
        {
            time_t currentTime = time(nullptr);
            if (currentTime <= (time_t)tokenExp - JWT_REFRESH_POLICY)
            {
                return true;
            }
            else
            {
                if (tokenExp > (uint32_t)currentTime)
                {
                    Serial.print("Will expire in (sec): ");
                    Serial.println(tokenExp - (uint32_t)currentTime);
                    Serial.println("JWT token is expiring soon. Refreshing...");
                    return RefreshJwtToken();
                }
                else
                {
                    Serial.println("TOKEN EXPIRED");
                    u_int32_t refreshTokenExp = getExpFromToken(jwtData->refreshToken);
                    if (refreshTokenExp < (uint32_t)currentTime)
                    {
                        Serial.println("REFRESH TOKEN EXPIRED !!!!");
                        prefService.ClearCredentials();
                        return false;
                    }
                    else
                    {
                        Serial.print("Refresh tokn will expire in (sec): ");
                        Serial.println(refreshTokenExp - (uint32_t)currentTime);
                        return RefreshJwtToken();
                    }
                }
            }
        }
    }

    JwtToken *GetCurrentJwtToken()
    {
        if (!jwtData || jwtData->token == "")
        {
            Serial.println("Getting JWT token from storage.");
            jwtData = prefService.GetJwtToken();

            // print jwt exp
            if (jwtData != nullptr && jwtData->token != "")
            {
                time_t currentTime = time(nullptr);
                tokenExp = getExpFromToken(jwtData->token);
                Serial.print("jwtExp : ");
                Serial.println(tokenExp);
                Serial.print("currentTime: ");
                Serial.println(currentTime);
                Serial.print("Will expire in (sec): ");
                if (tokenExp > (uint32_t)currentTime)
                {
                    Serial.println(tokenExp - (uint32_t)currentTime);
                }
                else
                {
                    Serial.println("EXPIRED");
                }
            }
        }
        if (RefreshJwtTokenIfNeeded())
        {
            // Serial.println("JWT token is valid.");
            return jwtData;
        }
        else
        {
            Serial.println("Failed to refresh JWT token.");
            return nullptr;
        }
        Serial.println("Current JWT token:");
        Serial.println(jwtData->token);
        return jwtData;
    }

    bool RefreshJwtToken()
    {
        Serial.println("Refreshing JWT token...");
        RefreashTokenRequest request;
        request.refreshToken = jwtData->refreshToken;

        GetLongLivedTokenResponse response = refreashTokenHttpClient.PostJson(jwtData->refreshTokenCallbackUrl, jwtData->refreshToken, &request, jwtData->validateCACert);

        if (response.mqttToken == "")
        {
            Serial.println("Failed to obtain permanent MQTT token from provisioning server.");
            return false;
        }

        Serial.println("Permanent MQTT token received:");
        Serial.println(response.mqttToken);

        jwtData = new JwtToken{
            .token = response.mqttToken,
            .refreshToken = response.refreshToken,
            .refreshTokenCallbackUrl = response.refreshTokenCallbackUrl,
            .deviceConfigUrl = response.deviceConfigUrl,
            .validateCACert = response.validateCACert,
            .deviceId = response.deviceId};

        tokenExp = getExpFromToken(response.mqttToken);

        prefService.SetJwtToken(*jwtData);
        return true;
    }

    JwtToken *RequestTempJwtToken(ProvisioningData &pData, String provisioningToken, String &registrationId, String &finalizeUrl)
    {
        GetLongLivedTokenRequest request;
        request.macAddress = WiFi.macAddress();
        request.deviceType = deviceType;
        request.provisioningToken = provisioningToken;
        request.version = DEVICE_VERSION;
        request.deviceId = GetDeviceId();

        RegisterDeviceResponse response = longLivedTokenHttpClient.PostJson(pData.provisioningCallbackUrl, pData.provisioningToken, &request, pData.validateCACert);

        if (response.mqttToken == "")
        {
            Serial.println("Failed to obtain temporary MQTT token from provisioning server.");
            return nullptr;
        }

        Serial.println("Temporary MQTT token received:");
        Serial.println(response.mqttToken);

        registrationId = response.registrationId;
        finalizeUrl = response.finalizeCallbackUrl;

        jwtData = new JwtToken{
            .token = response.mqttToken,
            .refreshToken = "",
            .refreshTokenCallbackUrl = "",
            .deviceConfigUrl = "",
            .validateCACert = response.validateCACert,
            .deviceId = 0};

        return jwtData;
    }

    JwtToken *FinalizeRegistration(String finalizeUrl, String registrationId, bool validateCACert)
    {
        FinalizeRegistrationRequest request;
        request.registrationId = registrationId;

        HttpJsonClientService<FinalizeRegistrationRequest, GetLongLivedTokenResponse> finalizeHttpClient;
        GetLongLivedTokenResponse response = finalizeHttpClient.PostJson(finalizeUrl, "", &request, validateCACert);

        if (response.mqttToken == "")
        {
            Serial.println("Failed to finalize registration.");
            return nullptr;
        }

        Serial.println("Permanent MQTT token received:");
        Serial.println(response.mqttToken);

        jwtData = new JwtToken{
            .token = response.mqttToken,
            .refreshToken = response.refreshToken,
            .refreshTokenCallbackUrl = response.refreshTokenCallbackUrl,
            .deviceConfigUrl = response.deviceConfigUrl,
            .validateCACert = response.validateCACert,
            .deviceId = response.deviceId};

        tokenExp = getExpFromToken(response.mqttToken);
        prefService.SetJwtToken(*jwtData);
        Serial.println("Permanent JWT token stored successfully.");
        return jwtData;
    }

    String GetDeviceId()
    {
        char deviceID[13];
        uint64_t mac = ESP.getEfuseMac();
        snprintf(deviceID, sizeof(deviceID), "%012llX", mac);
        Serial.print("Device ID: ");
        Serial.println(deviceID);
        return String(deviceID);
    }

    uint32_t getExpFromToken(String token)
    {
        // 1. Extract the payload (the part between the two dots)
        int firstDot = token.indexOf('.');
        int secondDot = token.indexOf('.', firstDot + 1);
        if (firstDot == -1 || secondDot == -1)
            return 0;

        String payload = token.substring(firstDot + 1, secondDot);

        // 2. Convert Base64URL to standard Base64
        payload.replace('-', '+');
        payload.replace('_', '/');
        while (payload.length() % 4 != 0)
            payload += '=';

        size_t outLen;
        unsigned char decoded[2048];
        mbedtls_base64_decode(decoded, sizeof(decoded), &outLen, (const unsigned char *)payload.c_str(), payload.length());
        decoded[outLen] = '\0';

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, decoded);
        if (error)
        {
            Serial.print(F("deserializeJson() failed: "));
            Serial.println(error.c_str());
            return 0;
        }
        String expStr = doc["exp"].as<String>();
        uint32_t expInt = strtoul(expStr.c_str(), NULL, 10);
        return expInt;
    }
};

// Global instance declaration
extern JwtService jwtService;
