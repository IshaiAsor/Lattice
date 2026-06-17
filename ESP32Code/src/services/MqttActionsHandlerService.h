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

        if (parts.empty())
            return;

        String message;
        message.reserve(length);
        for (unsigned int i = 0; i < length; i++)
            message += (char)payload[i];

        // Handle OTA topic first — `ota/updates/<deviceType>` has only 3 parts, so this must run
        // before we index parts[1/3/5/6] (which only exist on the 7-part command topic).
        if (strcmp(parts[0], "ota") == 0)
        {
            // Authenticate the firmware download with the device's current JWT.
            JwtToken *jwt = jwtService.GetCurrentJwtToken();
            otaService->handleUpdateMessage(message.c_str(), jwt ? jwt->token.c_str() : "");
            return;
        }

        if (parts.size() < 7)
        {
            Serial.printf("[MQTT] Unexpected topic format (%d parts) — ignoring\n", (int)parts.size());
            return;
        }

        char *userId     = parts[1];
        char *deviceId   = parts[3];
        char *actionType = parts[5];
        char *action     = parts[6];

        Serial.print("User ID: ");
        Serial.println(userId);
        Serial.print("Device ID: ");
        Serial.println(deviceId);
        Serial.print("Action Type: ");
        Serial.println(actionType);
        Serial.print("Action: ");
        Serial.println(action);

        if (strcmp(actionType, "status") == 0)
        {
            Serial.print("Device : ");
            Serial.print(deviceId);
            Serial.print(" is : ");
            Serial.println(message);
        }
        else if (strcmp(actionType, "command") == 0)
        {
            if (strcmp(action, "reprovision") == 0 || strcmp(action, "soft-reset") == 0)
            {
                Serial.println("[MQTT] Soft reset: clearing IoT credentials and restarting...");
                PreferencesManagerService p;
                p.ClearCredentials();
                ESP.restart();
                return;
            }
            if (strcmp(action, "hard-reset") == 0)
            {
                Serial.println("[MQTT] Hard reset: erasing all NVS data and restarting...");
                PreferencesManagerService p;
                p.ClearAllCredentials();
                ESP.restart();
                return;
            }
            if (strcmp(action, "restart") == 0)
            {
                Serial.println("[MQTT] Restart: rebooting device...");
                ESP.restart();
                return;
            }
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
