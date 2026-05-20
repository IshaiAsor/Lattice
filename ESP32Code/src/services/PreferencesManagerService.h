#pragma once
#include <Preferences.h>
#include <Arduino.h>

typedef struct
{
  String server;
  uint32_t port;
  String clientId;
  String userId;
  bool validateCACert;
} MqttCredentials;

typedef struct
{
  String token;
  String refreshToken;
  String refreshTokenCallbackUrl;
  bool validateCACert;
  uint32_t deviceId;
} JwtToken;

class PreferencesManagerService
{
  Preferences preferences;
  const char *PREF_NAMESPACE = "iot-creds";

public:
  void SaveMqttServerCredentials(MqttCredentials &mqttData)
  {
    preferences.begin(PREF_NAMESPACE, false);
    preferences.putString("mqtt_server", mqttData.server);
    preferences.putUInt("mqtt_port", mqttData.port);
    preferences.putBool("validateCACert", mqttData.validateCACert);
    preferences.putString("client_id", mqttData.clientId);
    preferences.putString("user", mqttData.userId);
    preferences.end();
  }

  MqttCredentials *LoadMqttServerCredentials()
  {
    preferences.begin(PREF_NAMESPACE, false);
    if (!preferences.isKey("mqtt_server") || !preferences.isKey("mqtt_port") || !preferences.isKey("validateCACert") || !preferences.isKey("client_id") || !preferences.isKey("user"))
    {
      Serial.println("No MQTT credentials found in storage.");
      preferences.clear();
      preferences.end();
      return nullptr;
    }
    MqttCredentials *mqttData = new MqttCredentials();
    mqttData->server = preferences.getString("mqtt_server", "");
    mqttData->port = preferences.getUInt("mqtt_port", 0);
    mqttData->validateCACert = preferences.getBool("validateCACert", false);
    mqttData->clientId = preferences.getString("client_id", "");
    mqttData->userId = preferences.getString("user", "");
    preferences.end();

    Serial.println("MQTT credentials retrieved:");
    Serial.print("Server: ");
    Serial.println(mqttData->server);
    Serial.print("Port: ");
    Serial.println(mqttData->port);
    Serial.print("validateCACert: ");
    Serial.println(mqttData->validateCACert);
    Serial.print("Client ID: ");
    Serial.println(mqttData->clientId);
    Serial.print("User ID: ");
    Serial.println(mqttData->userId);
    return mqttData;
  }

  void SetJwtToken(JwtToken &jwtData)
  {
    preferences.begin(PREF_NAMESPACE, false);
    preferences.putString("token", jwtData.token);
    preferences.putString("refresh_token", jwtData.refreshToken);
    preferences.putString("ref_token_url", jwtData.refreshTokenCallbackUrl);
    preferences.putBool("validateCACert", jwtData.validateCACert);
    preferences.putUInt("device_id", jwtData.deviceId);
    preferences.end();
  }

  JwtToken *GetJwtToken()
  {
    preferences.begin(PREF_NAMESPACE, false);
    if (!preferences.isKey("token") || !preferences.isKey("refresh_token") || !preferences.isKey("ref_token_url") || !preferences.isKey("validateCACert") || !preferences.isKey("device_id"))
    {
      Serial.println("No JWT token found in storage.");
      preferences.clear();
      preferences.end();
      return nullptr;
    }
    JwtToken *jwtData = new JwtToken{
        .token = preferences.getString("token", ""),
        .refreshToken = preferences.getString("refresh_token", ""),
        .refreshTokenCallbackUrl = preferences.getString("ref_token_url", ""),
        .validateCACert = preferences.getBool("validateCACert", false),
        .deviceId = preferences.getUInt("device_id", 0)};

    preferences.end();
    Serial.println("JWT token retrieved:");
    Serial.print("Token: ");
    Serial.println(jwtData->token);
    Serial.print("Refresh Token: ");
    Serial.println(jwtData->refreshToken);
    Serial.print("Refresh Token Callback URL: ");
    Serial.println(jwtData->refreshTokenCallbackUrl);
    Serial.print("validateCACert: ");
    Serial.println(jwtData->validateCACert);
    Serial.print("Device ID: ");
    Serial.println(jwtData->deviceId);
    return jwtData;
  }

  void ClearCredentials()
  {
    preferences.begin(PREF_NAMESPACE, false);
    preferences.clear();
    preferences.end();
  }

  void SaveActionState(char *action, char *state)
  {
    preferences.begin(PREF_NAMESPACE, false);
    preferences.putString(action, state);
    preferences.end();
  }

  char *LoadActionState(char *action)
  {
    preferences.begin(PREF_NAMESPACE, false);
    if (preferences.isKey(action))
    {
      return (char *)preferences.getString(action, "").c_str();
    }
    preferences.end();
    return nullptr;
  }
};
