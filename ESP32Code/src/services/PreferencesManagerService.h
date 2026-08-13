#pragma once
#include <Preferences.h>
#include <Arduino.h>
#include <nvs_flash.h>
#include "config/Log.h"

typedef struct
{
    String   server;
    uint32_t port;
    String   clientId;
    String   userId;
} MqttCredentials;

typedef struct
{
    String   token;
    String   refreshToken;
    String   refreshTokenCallbackUrl;
    String   deviceConfigUrl;
    uint32_t deviceId;
    String   wsStreamUrl;
    String   cameraHttpUrl;
} JwtToken;

class PreferencesManagerService
{
    Preferences preferences;
    const char* PREF_NAMESPACE = "iot-creds";

  public:
    void SaveMqttServerCredentials(MqttCredentials& mqttData)
    {
        preferences.begin(PREF_NAMESPACE, false);
        preferences.putString("mqtt_server", mqttData.server);
        preferences.putUInt("mqtt_port", mqttData.port);
        preferences.putString("client_id", mqttData.clientId);
        preferences.putString("user", mqttData.userId);
        preferences.end();
    }

    MqttCredentials* LoadMqttServerCredentials()
    {
        preferences.begin(PREF_NAMESPACE, false);
        if (!preferences.isKey("mqtt_server") || !preferences.isKey("mqtt_port") || !preferences.isKey("client_id") ||
            !preferences.isKey("user"))
        {
            // Report the gap; do NOT clear. This is a read — wiping the namespace here also
            // destroyed the JWT, the refresh token and every saved action state, turning one
            // missing key into a full loss of provisioning.
            LOG_W("Prefs", "no MQTT credentials in storage");
            preferences.end();
            return nullptr;
        }
        MqttCredentials* mqttData = new MqttCredentials();
        mqttData->server          = preferences.getString("mqtt_server", "");
        mqttData->port            = preferences.getUInt("mqtt_port", 0);
        mqttData->clientId        = preferences.getString("client_id", "");
        mqttData->userId          = preferences.getString("user", "");
        preferences.end();

        LOG_D("Prefs", "MQTT credentials retrieved: server=%s port=%u clientId=%s userId=%s", mqttData->server.c_str(),
              mqttData->port, mqttData->clientId.c_str(), mqttData->userId.c_str());
        return mqttData;
    }

    void SetJwtToken(JwtToken& jwtData)
    {
        preferences.begin(PREF_NAMESPACE, false);
        preferences.putString("token", jwtData.token);
        preferences.putString("refresh_token", jwtData.refreshToken);
        preferences.putString("ref_token_url", jwtData.refreshTokenCallbackUrl);
        preferences.putString("config_url", jwtData.deviceConfigUrl);
        preferences.putUInt("device_id", jwtData.deviceId);
        preferences.putString("ws_stream_url", jwtData.wsStreamUrl);
        preferences.putString("camera_url", jwtData.cameraHttpUrl);
        preferences.end();
    }

    JwtToken* GetJwtToken()
    {
        preferences.begin(PREF_NAMESPACE, false);
        if (!preferences.isKey("token") || !preferences.isKey("refresh_token") || !preferences.isKey("ref_token_url") ||
            !preferences.isKey("device_id"))
        {
            // Report the gap; do NOT clear. Same reasoning as LoadMqttServerCredentials above: this
            // is a read, and wiping the namespace here also destroyed mqtt_server/client_id/user and
            // every saved action state, turning one missing key into a full loss of provisioning.
            LOG_W("Prefs", "no JWT token in storage");
            preferences.end();
            return nullptr;
        }
        JwtToken* jwtData = new JwtToken{
            .token                   = preferences.getString("token", ""),
            .refreshToken            = preferences.getString("refresh_token", ""),
            .refreshTokenCallbackUrl = preferences.getString("ref_token_url", ""),
            .deviceConfigUrl         = preferences.getString("config_url", ""),
            .deviceId                = preferences.getUInt("device_id", 0),
            .wsStreamUrl             = preferences.getString("ws_stream_url", ""),
            .cameraHttpUrl           = preferences.getString("camera_url", ""),
        };

        preferences.end();
        // Never log the token itself — length only.
        LOG_D("Prefs", "JWT retrieved: token(%u chars) configUrl=%s wsUrl=%s cameraUrl=%s", jwtData->token.length(),
              jwtData->deviceConfigUrl.c_str(), jwtData->wsStreamUrl.c_str(), jwtData->cameraHttpUrl.c_str());
        return jwtData;
    }

    void ClearCredentials()
    {
        preferences.begin(PREF_NAMESPACE, false);
        preferences.clear();
        preferences.end();
    }

    void ClearAllCredentials()
    {
        preferences.begin(PREF_NAMESPACE, false);
        preferences.clear();
        preferences.end();
        nvs_flash_deinit();
        nvs_flash_erase();
        nvs_flash_init();
    }

    void SaveActionState(char* action, char* state)
    {
        preferences.begin(PREF_NAMESPACE, false);
        preferences.putString(action, state);
        preferences.end();
    }

    String LoadActionState(char* action)
    {
        preferences.begin(PREF_NAMESPACE, false);
        String value = "";
        if (preferences.isKey(action))
        {
            value = preferences.getString(action, "");
        }
        preferences.end();
        return value;
    }
};
