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
#include "models/ProvisionRequest.h"
#include "services/DeviceCapabilitiesService.h"
#include <WiFi.h>
#include "config/settings.h"
#include "models/ProvisioningData.h"
#include "mbedtls/base64.h"
#include "config/Log.h"

class JwtService
{
  private:
    PreferencesManagerService                                              prefService;
    HttpJsonClientService<RefreashTokenRequest, GetLongLivedTokenResponse> refreashTokenHttpClient;

    const char* deviceType = DEVICE_TYPE;
    JwtToken*   jwtData;
    uint32_t    tokenExp = 0;

  public:
    JwtService() {}
    ~JwtService() {}

    bool RefreshJwtTokenIfNeeded()
    {
        if (jwtData == nullptr)
        {
            LOG_W("Jwt", "no JWT token in storage");
            return false;
        }
        else
        {
            time_t currentTime = time(nullptr);
            // An unsynced clock reads as 1970. Judging expiry against it is meaningless and
            // actively dangerous — it reaches the credential-clearing branch below and wipes
            // provisioning over what is really just "NTP hasn't answered yet". Hold the
            // current token; the next tick re-checks once the clock is real.
            if (currentTime < MIN_VALID_EPOCH)
            {
                LOG_W("Jwt", "clock not synced — deferring expiry check, keeping current token");
                return true;
            }
            if (currentTime <= (time_t)tokenExp - JWT_REFRESH_POLICY)
            {
                return true;
            }
            else
            {
                if (tokenExp > (uint32_t)currentTime)
                {
                    LOG_I("Jwt", "token expiring in %u s — refreshing", tokenExp - (uint32_t)currentTime);
                    return RefreshJwtToken();
                }
                else
                {
                    LOG_W("Jwt", "token expired");
                    u_int32_t refreshTokenExp = getExpFromToken(jwtData->refreshToken);
                    if (refreshTokenExp == 0)
                    {
                        // No readable exp — a malformed or truncated read, not proof of
                        // expiry. Clearing here would brick a device over a bad NVS read.
                        LOG_E("Jwt", "refresh token has no readable exp — leaving credentials intact");
                        return false;
                    }
                    if (refreshTokenExp < (uint32_t)currentTime)
                    {
                        // The one legitimate clear: a genuinely expired refresh token against
                        // a synced clock cannot be recovered without re-provisioning.
                        LOG_E("Jwt", "refresh token expired — clearing credentials");
                        prefService.ClearCredentials();
                        return false;
                    }
                    else
                    {
                        LOG_I("Jwt", "refresh token valid for %u s — refreshing",
                              (uint32_t)(refreshTokenExp - currentTime));
                        return RefreshJwtToken();
                    }
                }
            }
        }
    }

    JwtToken* GetCurrentJwtToken()
    {
        if (!jwtData || jwtData->token == "")
        {
            LOG_D("Jwt", "loading JWT token from storage");
            jwtData = prefService.GetJwtToken();

            if (jwtData != nullptr && jwtData->token != "")
            {
                time_t currentTime = time(nullptr);
                tokenExp           = getExpFromToken(jwtData->token);
                if (tokenExp > (uint32_t)currentTime)
                    LOG_D("Jwt", "token exp=%u now=%ld — expires in %u s", tokenExp, (long)currentTime,
                          tokenExp - (uint32_t)currentTime);
                else
                    LOG_W("Jwt", "stored token already expired (exp=%u now=%ld)", tokenExp, (long)currentTime);
            }
        }
        if (RefreshJwtTokenIfNeeded())
        {
            return jwtData;
        }
        LOG_E("Jwt", "failed to refresh JWT token");
        return nullptr;
    }

    bool RefreshJwtToken()
    {
        LOG_I("Jwt", "refreshing JWT token");
        RefreashTokenRequest request;
        request.refreshToken = jwtData->refreshToken;

        GetLongLivedTokenResponse response =
            refreashTokenHttpClient.PostJson(jwtData->refreshTokenCallbackUrl, jwtData->refreshToken, &request);

        if (response.mqttToken == "")
        {
            LOG_E("Jwt", "failed to obtain permanent MQTT token from provisioning server");
            return false;
        }

        LOG_I("Jwt", "permanent MQTT token received (%u chars)", response.mqttToken.length());

        // Preserve existing service URLs if the refresh response omits them
        JwtToken* previous = jwtData;
        jwtData            = new JwtToken{
            .token                   = response.mqttToken,
            .refreshToken            = response.refreshToken != "" ? response.refreshToken : jwtData->refreshToken,
            .refreshTokenCallbackUrl = response.refreshTokenCallbackUrl != "" ? response.refreshTokenCallbackUrl
                                                                              : jwtData->refreshTokenCallbackUrl,
            .deviceConfigUrl = response.deviceConfigUrl != "" ? response.deviceConfigUrl : jwtData->deviceConfigUrl,
            .deviceId        = response.deviceId != 0 ? response.deviceId : jwtData->deviceId,
            .wsStreamUrl     = response.wsStreamUrl != "" ? response.wsStreamUrl : jwtData->wsStreamUrl,
            .cameraHttpUrl   = response.cameraHttpUrl != "" ? response.cameraHttpUrl : jwtData->cameraHttpUrl,
        };

        // The replacement copied everything it needed out of the old token above; release it
        // so a device that refreshes for months on end doesn't leak one JwtToken per refresh.
        delete previous;

        tokenExp = getExpFromToken(response.mqttToken);

        prefService.SetJwtToken(*jwtData);
        return true;
    }

    JwtToken* Provision(ProvisioningData& pData, String provisioningToken)
    {
        ProvisionRequest request;
        request.macAddress   = WiFi.macAddress();
        request.deviceType   = deviceType;
        request.version      = DEVICE_VERSION;
        request.capabilities = DeviceCapabilitiesService::getCapabilities();

        HttpJsonClientService<ProvisionRequest, GetLongLivedTokenResponse> provisionClient;
        GetLongLivedTokenResponse                                          response =
            provisionClient.PostJson(pData.provisioningCallbackUrl, provisioningToken, &request);

        if (response.mqttToken == "")
        {
            LOG_E("Jwt", "failed to obtain permanent JWT token from provisioning server");
            return nullptr;
        }

        LOG_I("Jwt", "permanent MQTT token received (%u chars)", response.mqttToken.length());

        jwtData = new JwtToken{
            .token                   = response.mqttToken,
            .refreshToken            = response.refreshToken,
            .refreshTokenCallbackUrl = response.refreshTokenCallbackUrl,
            .deviceConfigUrl         = response.deviceConfigUrl,
            .deviceId                = response.deviceId,
            .wsStreamUrl             = response.wsStreamUrl,
            .cameraHttpUrl           = response.cameraHttpUrl,
        };

        tokenExp = getExpFromToken(response.mqttToken);
        prefService.SetJwtToken(*jwtData);
        LOG_I("Jwt", "permanent JWT token stored");
        return jwtData;
    }

    String GetDeviceId()
    {
        char     deviceID[13];
        uint64_t mac = ESP.getEfuseMac();
        snprintf(deviceID, sizeof(deviceID), "%012llX", mac);
        LOG_D("Jwt", "device ID: %s", deviceID);
        return String(deviceID);
    }

    uint32_t getExpFromToken(String token)
    {
        // 1. Extract the payload (the part between the two dots)
        int firstDot  = token.indexOf('.');
        int secondDot = token.indexOf('.', firstDot + 1);
        if (firstDot == -1 || secondDot == -1)
            return 0;

        String payload = token.substring(firstDot + 1, secondDot);

        // 2. Convert Base64URL to standard Base64
        payload.replace('-', '+');
        payload.replace('_', '/');
        while (payload.length() % 4 != 0)
            payload += '=';

        size_t        outLen;
        unsigned char decoded[2048];
        mbedtls_base64_decode(decoded, sizeof(decoded), &outLen, (const unsigned char*)payload.c_str(),
                              payload.length());
        decoded[outLen] = '\0';

        JsonDocument         doc;
        DeserializationError error = deserializeJson(doc, decoded);
        if (error)
        {
            LOG_W("Jwt", "token payload parse failed: %s", error.c_str());
            return 0;
        }
        String   expStr = doc["exp"].as<String>();
        uint32_t expInt = strtoul(expStr.c_str(), NULL, 10);
        return expInt;
    }
};

// Global instance declaration
extern JwtService jwtService;
