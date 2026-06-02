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
    JwtService &jwtService;
    JwtToken *jwtData = nullptr;
    MqttCredentials *creds = nullptr;
    MqttActionsHandlerService *mqttActionsHandler;
    OtaService *otaService = nullptr;

public:
    MqttService(WiFiClientSecure &espClient, JwtService &jwtService) : espClient(espClient), jwtService(jwtService)
    {
        espClient.setCACert(root_ca);
        espClient.setHandshakeTimeout(10000);
        client = new PubSubClient(espClient);
#ifdef HAS_CAMERA
        client->setBufferSize(65535);
#else
        client->setBufferSize(2048);
#endif
        client->setKeepAlive(60);
        client->setCallback(MqttActionsHandlerService::callback);
        otaService = new OtaService(DEVICE_VERSION, DEVICE_TYPE, root_ca);
    }
    ~MqttService() {};

    bool connected()
    {
        return client->connected();
    }

    bool testMqtt(MqttCredentials *creds, JwtToken *token)
    {
        WiFiClientSecure testClient;
        Serial.println("Attempting to connect to MQTT... ");
        if (!creds->validateCACert)
        {
            testClient.setInsecure();
        }
        else
        {
            testClient.setCACert(root_ca);
        }
        testClient.setHandshakeTimeout(10000);
        PubSubClient testPubSubClient(testClient);
#ifdef HAS_CAMERA
        testPubSubClient.setBufferSize(65535);
#else
        testPubSubClient.setBufferSize(2048);
#endif
        testPubSubClient.setKeepAlive(10);
        testPubSubClient.setServer(creds->server.c_str(), creds->port);


        int attempt = 0;
        const int max_attempts = 5;

        while (!testPubSubClient.connected() && attempt < max_attempts)
        {
            if (testPubSubClient.connect(creds->clientId.c_str(), creds->userId.c_str(), token->token.c_str()))
            {
                Serial.println("connected");
            }
            else
            {
                Serial.print("failed, rc=");
                Serial.print(testPubSubClient.state());
                char err_buf[100];
                testClient.lastError(err_buf, 100);
                Serial.print(" | SSL Error: ");
                Serial.println(err_buf);
                Serial.println(" try again in 5 seconds");
                delay(5000);
                attempt++;
            }
        }

        if (!testPubSubClient.connected())
        {
            Serial.println("Max MQTT connection attempts reached. Clearing credentials and restarting...");

            return false;
        }
        return true;
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
        if (creds == nullptr)
        {
            Serial.println("No MQTT credentials available. Cannot connect to MQTT.");
            creds = prefService.LoadMqttServerCredentials();

            if (!creds)
            {
                Serial.println("No MQTT credentials available. Cannot connect to MQTT.");
                return false;
            }
        }

        if (!creds->validateCACert)
        {
            espClient.setInsecure();
        }
        else
        {
            espClient.setCACert(root_ca);
        }

        client->setServer(creds->server.c_str(), creds->port);

        String commandTopicStr = String(COMMAND_TOPIC);
        commandTopicStr.replace("%{userid}", creds->userId.c_str());
        commandTopicStr.replace("%{deviceid}", creds->clientId.c_str());
        commandTopicStr.replace("%{version}", DEVICE_VERSION);

        String statusTopicStr = String(STATUS_TOPIC);
        statusTopicStr.replace("%{userid}", creds->userId.c_str());
        statusTopicStr.replace("%{deviceid}", creds->clientId.c_str());
        statusTopicStr.replace("%{version}", DEVICE_VERSION);

        String otaTopicStr = String(OTA_TOPIC);
        otaTopicStr.replace("%{devicetype}", DEVICE_TYPE);

        int attempt = 0;
        const int max_attempts = 5;

        while (!client->connected() && attempt < max_attempts)
        {
            if (client->connect(creds->clientId.c_str(), creds->userId.c_str(), jwtData->token.c_str(), statusTopicStr.c_str(), 0, true, "offline"))
            {
                client->publish(statusTopicStr.c_str(), "online", true);
                client->subscribe(commandTopicStr.c_str());
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
            if (jwtData == nullptr)
            {
                Serial.println("No cached JWT token in MQTT service. Loading from storage...");
                jwtData = jwtService.GetCurrentJwtToken();
                if (!jwtData)
                {
                    Serial.println("Unable to retrieve JWT token for refresh. Clearing credentials and restarting...");
                    prefService.ClearCredentials();
                    ESP.restart();
                }
            }
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
            return true;
        }
        return false;
    }

    void publishTelemetry(const char *actionType, const char *payload)
    {
        if (client != nullptr && client->connected())
        {
            String telemetryTopicStr = String(TELEMETRY_TOPIC);
            telemetryTopicStr.replace("%{userid}", creds->userId.c_str());
            telemetryTopicStr.replace("%{deviceid}", creds->clientId.c_str());
            telemetryTopicStr.replace("%{version}", DEVICE_VERSION);
            telemetryTopicStr.replace("#", actionType);
            client->publish(telemetryTopicStr.c_str(), payload);
        }
        else
        {
            Serial.println("Cannot publish telemetry: MQTT client not connected.");
        }
    }
};
