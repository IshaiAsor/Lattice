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
#ifdef FREE_BLE_BEFORE_TLS
// Defined in main.cpp — releases the BLE stack so mbedTLS can allocate on low-heap boards.
extern void teardownBleForTls();
#endif

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

    /**
     * Scan for networks and stream them back, one BLE notification per network.
     *
     * Sending the list as a single blob would need a chunking protocol: a dozen SSIDs overrun the
     * negotiated MTU, and this characteristic has no reassembly on either side. One network per
     * notification sidesteps that entirely — every frame is a few dozen bytes.
     */
    void HandleWifiScan()
    {
        LOG_I("Provision", "scanning for WiFi networks");

        // Scanning needs station mode. The device is in AP+STA or STA already for the portal path,
        // but a fresh boot with no credentials may be idle, so assert it.
        WiFi.mode(WIFI_STA);
        int found = WiFi.scanNetworks();

        if (found < 0)
        {
            LOG_E("Provision", "WiFi scan failed (%d)", found);
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_ERROR, "FAIL: Scan failed");
            return;
        }

        LOG_I("Provision", "scan found %d networks", found);

        for (int i = 0; i < found; i++)
        {
            // "<rssi>|<secured>|<ssid>" — the SSID goes last so a '|' inside it survives a
            // split-on-first-two-delimiters on the app side.
            char line[BLE_RESPONSE_MAX_LEN];
            snprintf(line, sizeof(line), "%d|%d|%s", WiFi.RSSI(i), WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? 0 : 1,
                     WiFi.SSID(i).c_str());
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_SCAN_RESULT, line);
            // The app's notification handler is single-threaded; back-to-back notifies on a fast
            // link can coalesce and drop. A short gap costs nothing on a scan of this size.
            delay(60);
        }

        WiFi.scanDelete();

        char summary[32];
        snprintf(summary, sizeof(summary), "%d", found);
        bleNotificationService->NotifyBleDevice(ResponseType::WIFI_SCAN_COMPLETE, summary);
    }

    /**
     * Join the network the user picked in the app.
     *
     * Sent as its own small write rather than folded into the provisioning payload, so that payload
     * stays exactly the size it is today — this characteristic assumes a single write with no
     * reassembly, and it already carries a JWT. On success the provisioning payload that follows
     * finds WiFi.isConnected() true and skips the captive portal with no change to that code.
     */
    void HandleWifiCredentials(JsonDocument& doc)
    {
        const char* ssid     = doc["ssid"] | "";
        const char* password = doc["password"] | "";

        if (strlen(ssid) == 0)
        {
            LOG_E("Provision", "wifi command with no ssid");
            bleNotificationService->NotifyBleDevice(ResponseType::MISSING_PARAMS, "FAIL: MISSING_PARAMS");
            return;
        }

        LOG_I("Provision", "connecting to WiFi chosen in app");
        bleNotificationService->NotifyBleDevice(ResponseType::WIFI_CONNECTING, "OK: Connecting...");

        WiFi.mode(WIFI_STA);
        WiFi.begin(ssid, password);

        // Long enough for DHCP on a slow AP, short enough that the user is not left staring at a
        // spinner. Failure is recoverable: the app falls back to offering the captive portal.
        const unsigned long timeoutMs = 25000;
        unsigned long       started   = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs)
        {
            delay(250);
        }

        if (WiFi.status() != WL_CONNECTED)
        {
            LOG_E("Provision", "could not join the network chosen in app");
            bleNotificationService->NotifyBleDevice(ResponseType::WIFI_ERROR, "FAIL: Could not join that network");
            return;
        }

        LOG_I("Provision", "WiFi connected from app-supplied credentials");
        bleNotificationService->NotifyBleDevice(ResponseType::WIFI_CONNECTED_SUCCESSFULLY, "OK: WiFi Connected");
    }

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

        // Short commands the app sends BEFORE the provisioning payload, so it can offer Wi-Fi
        // selection in the app instead of sending the user to the device's captive portal. A write
        // without "cmd" is the provisioning payload and takes the original path untouched — which
        // is what keeps an older app working against this firmware.
        const char* cmd = doc["cmd"] | "";
        if (strcmp(cmd, "scan") == 0)
        {
            HandleWifiScan();
            return;
        }
        if (strcmp(cmd, "wifi") == 0)
        {
            HandleWifiCredentials(doc);
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

#ifdef FREE_BLE_BEFORE_TLS
        // Low-heap board: this is the last BLE notify the phone will receive. Give it a moment
        // to flush, then release the BLE stack so the TLS handshakes below can allocate. The
        // device restarts at the end of provisioning regardless, so BLE is not needed again;
        // the phone sees a disconnect and the device comes back online on success.
        delay(500);
        teardownBleForTls();
#endif

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
