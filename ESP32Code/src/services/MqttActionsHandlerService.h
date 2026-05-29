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
#include "actions/DynamicDeviceActionsService.h"
#include "OtaService.h"

extern DynamicDeviceActionsService deviceActionsService;

class MqttActionsHandlerService
{
public:
    MqttActionsHandlerService();
    ~MqttActionsHandlerService();

    static void callback(char *topic, byte *payload, unsigned int length)
    {
        static OtaService *otaService = new OtaService(DEVICE_VERSION, DEVICE_TYPE, root_ca);
        Serial.print("Message arrived on topic: ");
        Serial.println(topic);

        std::vector<char *> parts;

        char *token = std::strtok(topic, "/");
        while (token != nullptr)
        {
            parts.push_back(token);
            token = std::strtok(nullptr, "/");
        }

        char *userId     = parts[1];
        char *deviceId   = parts[3];
        char *actionType = parts[4];
        char *action     = parts[5];

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
            message += (char)payload[i];

        // Handle OTA topic
        if (strcmp(parts[0], "ota") == 0)
        {
            otaService->handleUpdateMessage(message.c_str());
            return;
        }

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
        for (size_t i = 0; i < deviceActionsService.getDeviceActionsCount(); i++)
        {
            BaseCommandAction *a = deviceActionsService.getDeviceActions()[i];
            if (a->actionName == actionName)
                return a;
        }
        Serial.println("Action not found: " + actionName);
        return nullptr;
    }
};
