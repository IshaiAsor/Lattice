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
#include "actions/commands/OnboardLedCommandAction.h"
extern OnboardLedAction onboardLed;

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
        MqttService *mqttService)
    {
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

        // Step 4: Exchange tokens with server (Step 1: Register)
        Serial.println("Requesting temporary MQTT token from provisioning server...");
        bleNotificationService->NotifyBleDevice(ResponseType::EXCHANGING_TOKENS_WITH_SERVER, "OK: Requesting temp token...");

        String registrationId;
        String finalizeUrl;
        JwtToken *tempJwtData = jwtService->RequestTempJwtToken(pData, pData.provisioningToken, registrationId, finalizeUrl);

        if (tempJwtData == nullptr)
        {
            Serial.println("Failed to request temporary JWT token.");
            bleNotificationService->NotifyBleDevice(ResponseType::PROVISIONING_FAILED, "Failed to get temp token from server.");
            return;
        }

        MqttCredentials mqttCreds;
        mqttCreds.server = pData.server;
        mqttCreds.port = pData.mqttPort;
        mqttCreds.validateCACert = pData.validateCACert;
        mqttCreds.clientId = WiFi.macAddress(); // Use MAC for temp clientid
        mqttCreds.userId = pData.userId;

        // Note: We don't save to preferences yet, just use in memory
        //  mqttService->updateCredentials(mqttCreds, tempJwtData->token);

        // Notify phone before BLE goes down, then release BLE memory.
        // BLE (Bluedroid) + WiFi together hold ~150 KB of DRAM, leaving nothing for
        // the ~32 KB mbedTLS SSL context. Deiniting BLE returns that memory so the
        // TLS handshake can succeed. The device restarts either way, so BLE is not needed anymore.
        Serial.println("Testing MQTT connection with temp token...");
        bleNotificationService->NotifyBleDevice(ResponseType::TESTING_MQTT_CONNECTION, "OK: Testing MQTT...");
        delay(300); // let the BLE notification flush before stack teardown
        

        if (!mqttService->testMqtt(&mqttCreds, tempJwtData))
        {
            Serial.println("MQTT connection failed. Restarting to retry provisioning...");
            onboardLed.execute("red");
            delay(2000);
            ESP.restart();
        }

        Serial.println("MQTT connection successful! Finalizing registration...");
        JwtToken *permanentJwtData = jwtService->FinalizeRegistration(finalizeUrl, registrationId, pData.validateCACert);

        if (permanentJwtData == nullptr)
        {
            Serial.println("Finalization failed. Restarting to retry provisioning...");
            onboardLed.execute("red");
            delay(2000);
            ESP.restart();
        }

        mqttCreds.clientId = String(permanentJwtData->deviceId);
        prefService->SaveMqttServerCredentials(mqttCreds);

        Serial.println("Provisioning successful and finalized!");
        bleNotificationService->NotifyBleDevice(ResponseType::PROVISIONING_SUCCESSFUL, "OK: Provisioning Complete");

        onboardLed.execute("green");

        delay(2000);
        ESP.restart();
        delay(1000); // Short delay before allowing next provisioning attempt
        Serial.println("Provisioning process complete.");
    }
};
