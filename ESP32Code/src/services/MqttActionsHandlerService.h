#pragma once
#include <Arduino.h>
#include <WiFiClient.h>
#include <WebSocketsClient.h>
#include <MQTTPubSubClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "mqtt.h"
#include "PreferencesManagerService.h"
#include "JwtService.h"
#include "actions/DeviceActions.h"

class MqttActionsHandlerService
{
public:
    MqttActionsHandlerService();
    ~MqttActionsHandlerService();

    static void callback(char *topic, byte *payload, unsigned int length)
    {
        Serial.print("Message arrived on topic: ");
        Serial.println(topic);
        // "users/%{userid}/devices/%{deviceid}/telemetry/#"

        std::vector<char *> parts;

        // Phase 1: Split and store pointers
        char *token = std::strtok(topic, "/");
        while (token != nullptr)
        {
            parts.push_back(token);
            token = std::strtok(nullptr, "/");
        }

        char *userId = parts[1];
        char *deviceId = parts[3];
        char *actionType = parts[4];
        char *action = parts[5];

        Serial.print("User ID: ");
        Serial.println(userId);
        Serial.print("Device ID: ");
        Serial.println(deviceId);
        Serial.print("Action Type: ");
        Serial.println(actionType);
        Serial.print("Action: ");
        Serial.println(action);

        String message;
        message.reserve(length);
        for (unsigned int i = 0; i < length; i++)
        {
            message += (char)payload[i];
        }
        Serial.print("Payload: ");
        Serial.println(message);

        Serial.println("-----------------------");

        // Handle outlet control
        if (strcmp(actionType, "status") == 0)
        {
            Serial.print("Device : ");
            Serial.print(deviceId);
            Serial.print(" is : ");
            Serial.println(message);
        }
        else if (strcmp(actionType, "command") == 0)
        {
            BaseCommandAction *deviceAction = getAction(action);
            if (deviceAction != nullptr)
            {
                deviceAction->execute(message);
                return;
            }
        }
        else if (strcmp(actionType, "telemetry") == 0)
        {
            Serial.println("Received telemetry:");
            Serial.print("Action: ");
            Serial.println(action);
            Serial.print("Message: ");
            Serial.println(message);
        }
        else
        {
            Serial.println("Unknown action type");
            Serial.println(actionType);
        }
    }

    static BaseCommandAction *getAction(String actionName)
    {
        for (int i = 0; i < sizeof(DEVICE_ACTIONS_SETUP) / sizeof(DEVICE_ACTIONS_SETUP[0]); i++)
        {
            if (strcmp(DEVICE_ACTIONS_SETUP[i]->actionName.c_str(), actionName.c_str()) == 0)
            {
                return DEVICE_ACTIONS_SETUP[i];
            }
        }

        Serial.println("Action not found");
        return nullptr;
    }
};
