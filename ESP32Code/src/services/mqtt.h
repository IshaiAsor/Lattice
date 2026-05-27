#pragma once
#include <Arduino.h>
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "PreferencesManagerService.h"
#include "JwtService.h"
#include "config/settings.h"
#include "MqttActionsHandlerService.h"
#include "Certs/cert.h"
#include "OtaService.h"
class MqttService
{
private:
    const char *root_ca = certificate_root;
    WiFiClientSecure &espClient;
    PubSubClient *client = nullptr;
    PreferencesManagerService prefService;
    JwtService jwtService;
    JwtToken *jwtData = nullptr;
    MqttCredentials *mqttCreds = nullptr;
    MqttActionsHandlerService *mqttActionsHandler;
    OtaService *otaService = nullptr;

public:
    MqttService(WiFiClientSecure &espClient) : espClient(espClient)
    {
        espClient.setCACert(root_ca);
        espClient.setHandshakeTimeout(10000);
        client = new PubSubClient(espClient);
        client->setBufferSize(2048);
        client->setKeepAlive(10);
        client->setCallback(MqttActionsHandlerService::callback);
        otaService = new OtaService(DEVICE_VERSION, DEVICE_TYPE, root_ca);
    }
    ~MqttService() {};

    bool connected()
    {
        return client->connected();
    }

    bool testMqtt()
    {
        return reconnectMqtt();
    }

    bool reconnectMqtt()
    {
        Serial.println("Attempting to reconnect to MQTT... ");
        if (jwtData == nullptr)
        {
            Serial.println("No JWT token available. Attempting to retrieve from storage...");
            jwtData = jwtService.GetCurrentJwtToken();
            if (!jwtData)
            {
                Serial.println("No JWT token available. Cannot connect to MQTT.");
                return false;
            }
        }
        if (mqttCreds == nullptr)
        {
            Serial.println("No MQTT credentials available. Cannot connect to MQTT.");
            mqttCreds = prefService.LoadMqttServerCredentials();

            if (!mqttCreds)
            {
                Serial.println("No MQTT credentials available. Cannot connect to MQTT.");
                return false;
            }
        }

        if (!mqttCreds->validateCACert)
        {
            espClient.setInsecure();
        }
        else
        {
            espClient.setCACert(root_ca);
        }

        client->setServer(mqttCreds->server.c_str(), mqttCreds->port);

        String commandTopicStr = String(COMMAND_TOPIC);
        commandTopicStr.replace("%{userid}", mqttCreds->userId.c_str());
        commandTopicStr.replace("%{deviceid}", mqttCreds->clientId.c_str());

        String statusTopicStr = String(STATUS_TOPIC);
        statusTopicStr.replace("%{userid}", mqttCreds->userId.c_str());
        statusTopicStr.replace("%{deviceid}", mqttCreds->clientId.c_str());

        String telemetryTopicStr = String(TELEMETRY_TOPIC);
        telemetryTopicStr.replace("%{userid}", mqttCreds->userId.c_str());
        telemetryTopicStr.replace("%{deviceid}", mqttCreds->clientId.c_str());

        String otaTopicStr = String(OTA_TOPIC);
        otaTopicStr.replace("%{devicetype}", DEVICE_TYPE);
        
        int attempt = 0;
        const int max_attempts = 5;

        while (!client->connected() && attempt < max_attempts)
        {
            if (client->connect(mqttCreds->clientId.c_str(), mqttCreds->userId.c_str(), jwtData->token.c_str(), statusTopicStr.c_str(), 0, true, "offline"))
            {
                client->publish(statusTopicStr.c_str(), "online", true);
                client->subscribe(commandTopicStr.c_str());
                client->subscribe(telemetryTopicStr.c_str());
                client->subscribe(otaTopicStr.c_str());

                Serial.println("connected and subscribed to topics");
            }
            else
            {
                Serial.print("failed, rc=");
                Serial.print(client->state());
                char err_buf[100];
                espClient.lastError(err_buf, 100);
                Serial.print(" | SSL Error: ");
                Serial.println(err_buf);
                Serial.println(" try again in 5 seconds");
                delay(5000);
                attempt++;
            }
        }

        if (!client->connected())
        {
            Serial.println("Max MQTT connection attempts reached. Clearing credentials and restarting...");

            return false;
        }
        return true;
    }

    bool loopMqtt()
    {
        if (client != nullptr && client->connected())
        {
            if (!jwtService.RefreshJwtTokenIfNeeded())
            {
                Serial.println("Failed to refresh JWT token. Clearing credentials and restarting...");
                prefService.ClearCredentials();
                ESP.restart();
            }
            client->loop();
            return true;
        }
        else
        {
            Serial.println("MQTT client disconnected. Attempting to reconnect...");
            Serial.print("MQTT client state: ");
            Serial.println(client->state());
            if (!reconnectMqtt())
            {
                Serial.println("Failed to reconnect to MQTT.");
                prefService.ClearCredentials();
                return false;
            }
        }
        return false;
    }

    void publishTelemetry(const char *actionType, const char *payload)
    {
        if (client != nullptr && client->connected())
        {
            String telemetryTopicStr = String(TELEMETRY_TOPIC);
            telemetryTopicStr.replace("%{userid}", mqttCreds->userId.c_str());
            telemetryTopicStr.replace("%{deviceid}", mqttCreds->clientId.c_str());
            telemetryTopicStr.replace("#", actionType);
            client->publish(telemetryTopicStr.c_str(), payload);
        }
        else
        {
            Serial.println("Cannot publish telemetry: MQTT client not connected.");
        }
    }
};
