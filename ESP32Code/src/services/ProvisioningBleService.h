#pragma once
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
#include "certs/cert.h"
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
#include "services/BleNotificationService.h"
#include "services/ProvisioningCallbacks.h"
#include "services/DateTimeSyncService.h"
#include "actions/commands/OnboardLedCommandAction.h"
#include "config/Log.h"
extern OnboardLedAction onboardLed;

class ProvisioningBleService
{
  private:
    /* data */
    BleNotificationService*    bleNotificationService;
    DateTimeSyncService*       dateTimeSyncService;
    WiFiManager*               wm;
    PreferencesManagerService* prefService;
    JwtService*                jwtService;
    MqttService*               mqttService;

  public:
    ProvisioningBleService(BleNotificationService* bleNotificationService, DateTimeSyncService* dateTimeSyncService,
                           WiFiManager* wm, PreferencesManagerService* prefService, JwtService* jwtService,
                           MqttService* mqttService)
    {
        this->bleNotificationService = bleNotificationService;
        this->dateTimeSyncService    = dateTimeSyncService;
        this->wm                     = wm;
        this->prefService            = prefService;
        this->jwtService             = jwtService;
        this->mqttService            = mqttService;
    }
    ~ProvisioningBleService() {}

    void HandleProvisioning(char* payload)
    {

        LOG_I("Provision", "provisioning data received from BLE; parsing in main task");
        bleNotificationService->NotifyBleDevice(ResponseType::PROCESSING, "OK: PROCESSING");

        JsonDocument         doc;
        DeserializationError error = deserializeJson(doc, payload);
        free(payload);

        if (error)
        {
            LOG_E("Provision", "payload parse failed: %s", error.c_str());
            bleNotificationService->NotifyBleDevice(ResponseType::JSON_ERROR, "FAIL: JSON_ERROR");
            return;
        }

        ProvisioningData pData;
        pData.fromJson(doc);

        if (!pData.valid())
        {
            LOG_E("Provision", "missing required provisioning parameters");
            bleNotificationService->NotifyBleDevice(ResponseType::MISSING_PARAMS, "FAIL: MISSING_PARAMS");
            return;
        }

        LOG_I("Provision", "testing WiFi connection");
        if (!WiFi.isConnected())
        {
            LOG_I("Provision", "no WiFi — opening config portal");
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_PROVISIONING_IN_PROGRESS,
                                                    "OK: Awaiting WiFi connection via portal...");

            if (!wm->startConfigPortal(AP_HOTSPOT_NAME, AP_HOTSPOT_PASSWORD))
            {
                LOG_E("Provision", "config portal failed or timed out");
                bleNotificationService->NotifyBleDevice(ResponseType::WIFI_ERROR, "FAIL: Portal timed out or failed.");
                return;
            }

            delay(1000);

            LOG_I("Provision", "WiFi connected via portal; credentials saved to flash");
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_CONNECTED_SUCCESSFULLY, "OK: WiFi Connected");
        }
        else
        {
            LOG_I("Provision", "WiFi already connected");
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_CONNECTED_SUCCESSFULLY, "OK: WiFi Connected");
        }
        dateTimeSyncService->syncTime();
        // Step 3: Request provisioning token from server
        LOG_I("Provision", "requesting permanent MQTT token from provisioning server");

        bleNotificationService->NotifyBleDevice(ResponseType::REQUESTING_PROVISIONING_TOKEN, "OK: Requesting token...");

        char     deviceID[13];
        uint64_t mac = ESP.getEfuseMac();
        snprintf(deviceID, sizeof(deviceID), "%012llX", mac);
        LOG_D("Provision", "device ID: %s", deviceID);

        // Step 4: Test MQTT reachability using provisioningToken (userId as clientId)
        MqttCredentials mqttCreds;
        mqttCreds.server   = pData.server;
        mqttCreds.port     = pData.mqttPort;
        mqttCreds.clientId = pData.userId; // matches clientid claim in provisioningToken JWT
        mqttCreds.userId   = pData.userId;

        JwtToken provToken;
        provToken.token = pData.provisioningToken;

        LOG_I("Provision", "testing MQTT reachability with provisioning token");
        bleNotificationService->NotifyBleDevice(ResponseType::TESTING_MQTT_CONNECTION, "OK: Testing MQTT...");
        delay(300); // let BLE TX flush before WiFi TCP

        if (!mqttService->testMqtt(&mqttCreds, &provToken))
        {
            LOG_E("Provision", "MQTT unreachable — restarting to retry provisioning");
            bleNotificationService->NotifyBleDevice(ResponseType::PROVISIONING_FAILED, "FAIL: MQTT unreachable");
            onboardLed.execute("red");
            delay(2000);
            ESP.restart();
        }

        // Step 5: Single provision call — server upserts device type, blueprints, user_device
        LOG_I("Provision", "MQTT reachable — sending provision request to server");
        bleNotificationService->NotifyBleDevice(ResponseType::EXCHANGING_TOKENS_WITH_SERVER,
                                                "OK: Registering device...");
        delay(500); // let BLE TX flush before WiFi TCP — they share the radio

        LOG_D("Provision", "WiFi IP: %s", WiFi.localIP().toString().c_str());

        JwtToken* permanentJwtData = jwtService->Provision(pData, pData.provisioningToken);

        if (permanentJwtData == nullptr)
        {
            LOG_E("Provision", "provision call failed — restarting to retry");
            bleNotificationService->NotifyBleDevice(ResponseType::PROVISIONING_FAILED, "FAIL: Server error");
            onboardLed.execute("red");
            delay(2000);
            ESP.restart();
        }

        mqttCreds.clientId = String(permanentJwtData->deviceId);
        prefService->SaveMqttServerCredentials(mqttCreds);

        LOG_I("Provision", "provisioning successful — restarting");
        bleNotificationService->NotifyBleDevice(ResponseType::PROVISIONING_SUCCESSFUL, "OK: Provisioning Complete");

        onboardLed.execute("green");

        delay(2000);
        ESP.restart();
    }
};
