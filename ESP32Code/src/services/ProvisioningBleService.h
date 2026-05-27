// #pragma once
#include <Arduino.h>
#include <cstring>
#include <cstdlib>
#include <WiFi.h>
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <ArduinoJson.h>
#include <nvs_flash.h>
#include "Certs/cert.h"
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include "services/PreferencesManagerService.h"
#include "models/ProvisioningData.h"
#include "models/BluetoothResponse.h"
#include "services/JwtService.h"
#include "services/mqtt.h"
#include <ESP32ProvisionToolkit.h>
#include "services/BleServer.h"
#include <WiFiManager.h>
#include "services/BleNotificationService.h"
#include "services/ProvisioningCallbacks.h"
#include "services/DateTimeSyncService.h"
#include "actions/DeviceActions.h"

class ProvisioningBleService
{
private:
    /* data */
    BleNotificationService *bleNotificationService;
    DateTimeSyncService *dateTimeSyncService;
    WiFiManager *wm;
    PreferencesManagerService *prefService;
    JwtService *jwtService;
    MqttService *mqttService;

public:
    ProvisioningBleService(
 BleNotificationService *bleNotificationService,
    DateTimeSyncService *dateTimeSyncService,
    WiFiManager *wm,
    PreferencesManagerService *prefService,
    JwtService *jwtService,
    MqttService *mqttService
    ){
        this->bleNotificationService = bleNotificationService;
        this->dateTimeSyncService = dateTimeSyncService;
        this->wm = wm;
        this->prefService = prefService;
        this->jwtService = jwtService;
        this->mqttService = mqttService;
    }
    ~ProvisioningBleService() {}

    void HandleProvisioning(char *payload)
    {

        Serial.println("Provisioning data received from BLE; parsing in main task.");
        bleNotificationService->NotifyBleDevice(ResponseType::PROCESSING, "OK: PROCESSING");

        Serial.println("Parsing provisioning payload...");
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, payload);
        free(payload);

        if (error)
        {
            Serial.print(F("deserializeJson() failed in provProcess: "));
            Serial.println(error.c_str());
            bleNotificationService->NotifyBleDevice(ResponseType::JSON_ERROR, "FAIL: JSON_ERROR");
            return;
        }

        ProvisioningData pData;
        pData.fromJson(doc);

        if (!pData.valid())
        {
            Serial.println("Missing required provisioning parameters");
            bleNotificationService->NotifyBleDevice(ResponseType::MISSING_PARAMS, "FAIL: MISSING_PARAMS");
            return;
        }

        Serial.println("Testing WiFi connection...");
        if (!WiFi.isConnected())
        {
            Serial.println("Provisioning in progress. Please wait...");
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_PROVISIONING_IN_PROGRESS, "OK: Awaiting WiFi connection via portal...");

            if (!wm->startConfigPortal(AP_HOTSPOT_NAME, AP_HOTSPOT_PASSWORD))
            {
                Serial.println("Failed to connect or hit timeout");
                bleNotificationService->NotifyBleDevice(ResponseType::WIFI_ERROR, "FAIL: Portal timed out or failed.");
                return;
            }

            delay(1000);

            Serial.println("Reconnected successfully. Credentials are now saved to flash.");
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_CONNECTED_SUCCESSFULLY, "OK: WiFi Connected");
        }
        else
        {
            Serial.println("WiFi connection successful!");
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_CONNECTED_SUCCESSFULLY, "OK: WiFi Connected");
        }
        dateTimeSyncService->syncTime();
        // Step 3: Request provisioning token from server
        Serial.println("Requesting permanent MQTT token from provisioning server...");

        bleNotificationService->NotifyBleDevice(ResponseType::REQUESTING_PROVISIONING_TOKEN, "OK: Requesting token...");

        char deviceID[13];
        uint64_t mac = ESP.getEfuseMac();
        snprintf(deviceID, sizeof(deviceID), "%012llX", mac);
        Serial.print("Device ID: ");
        Serial.println(deviceID);

        // Step 4: Exchange tokens with server
        Serial.println("Exchanging tokens with provisioning server...");
        bleNotificationService->NotifyBleDevice(ResponseType::EXCHANGING_TOKENS_WITH_SERVER, "OK: Exchanging tokens...");

        JwtToken *jwtData = jwtService->RequestPermenentJwtToken(pData, pData.provisioningToken);

        if (jwtData == nullptr)
        {
            Serial.println("Failed to request permanent JWT token.");
            bleNotificationService->NotifyBleDevice(ResponseType::PROVISIONING_FAILED, "Failed to exchange tokens with server.");
            return;
        }

        bleNotificationService->NotifyBleDevice(ResponseType::TOKENS_EXCHANGED_SUCCESSFULLY, "OK: Tokens exchanged");

        MqttCredentials mqttCreds;
        mqttCreds.server = pData.server;
        mqttCreds.port = pData.mqttPort;
        mqttCreds.validateCACert = pData.validateCACert;
        mqttCreds.clientId = jwtData->deviceId;
        mqttCreds.userId = pData.userId;

        prefService->SaveMqttServerCredentials(mqttCreds);
        Serial.println("MQTT credentials and JWT token saved.");

        // Test MQTT connection
        Serial.println("Testing MQTT connection...");
        bleNotificationService->NotifyBleDevice(ResponseType::TESTING_MQTT_CONNECTION, "OK: Testing MQTT...");

        if (!mqttService->reconnectMqtt())
        {
            Serial.println("MQTT connection failed.");
            bleNotificationService->NotifyBleDevice(ResponseType::PROVISIONING_FAILED, "FAIL: MQTT connection failed.");
            prefService->ClearCredentials(); // Clear credentials to allow retry
                                             // ESP.restart(); // Restart to re-enter provisioning mode
        }
        else
        {
            Serial.println("MQTT connection successful! Provisioning complete.");
            bleNotificationService->NotifyBleDevice(ResponseType::MQTT_CONNECTION_SUCCESSFUL, "OK: MQTT Connected");

            bleNotificationService->NotifyBleDevice(ResponseType::PROVISIONING_SUCCESSFUL, "OK: Provisioning Complete");

            onboardLed.execute("green");

            delay(2000);   // Give time for notification to send
            ESP.restart(); // Restart to connect with new credentials
        }
        delay(1000); // Short delay before allowing next provisioning attempt
        Serial.println("Provisioning process complete.");
    }
};
