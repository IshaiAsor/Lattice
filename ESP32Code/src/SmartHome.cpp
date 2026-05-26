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
#include <WiFiManager.h>
#include "services/BleNotificationService.h"
#include "services/ProvisioningCallbacks.h"
#include "services/DateTimeSyncService.h"
#include "actions/DeviceActions.h"
#include "services/ProvisioningBleService.h"
const char *root_ca = certificate_root;

unsigned long buttonPressTime = 0;
unsigned long previousMillis = 0;

bool isPressing = false;

bool provisioningMode = false;

QueueHandle_t provisioningQueue = NULL;
QueueHandle_t bleResponseQueue = NULL;

WiFiManager wm;
WiFiClientSecure espClient;
PreferencesManagerService prefService;
JwtService jwtService;
DateTimeSyncService dateTimeSyncService;
BleServer bleServer;
MqttService mqttService(espClient);
BleNotificationService bleNotificationService(&bleServer, &bleResponseQueue);
ProvisioningCallbacks provisioningCallbacks(&bleNotificationService, &provisioningQueue);
ProvisioningBleService provisioningBleService(&bleNotificationService, &dateTimeSyncService, &wm, &prefService, &jwtService, &mqttService);
BLECharacteristic *pCharacteristic;

void setupBleProvisioning();
void bleResponseTask(void *pvParameters);
void handleTelematryReading();
void handleProvisioningQueue();
void handleReset();
void performFactoryReset();
void loopCommnds();

void setup()
{
  Serial.begin(115200);
  delay(1000); // Allow time for Serial to initialize
  Serial.println("Device Starting...");

  if (digitalRead(BUTTON_PIN) == LOW)
  {
    Serial.println("Boot button press detected. Initiating factory reset...");
    performFactoryReset();
  }

  size_t actionCount = sizeof(DEVICE_ACTIONS_SETUP) / sizeof(DEVICE_ACTIONS_SETUP[0]);
  for (int i = 0; i < actionCount; i++)
  {
    DEVICE_ACTIONS_SETUP[i]->initPins();
  }

  size_t telActionCount = sizeof(TELEMETRY_ACTIONS_SETUP) / sizeof(TELEMETRY_ACTIONS_SETUP[0]);
  for (int i = 0; i < telActionCount; i++)
  {
    TELEMETRY_ACTIONS_SETUP[i]->initPins();
  }
  onboardLed.execute("orange");

  provisioningQueue = xQueueCreate(1, sizeof(char *));
  bleResponseQueue = xQueueCreate(5, sizeof(BluetoothResponse));

  if (provisioningQueue == NULL || bleResponseQueue == NULL)
  {
    Serial.println("ERROR: Could not create queues!");
  }

  // Create BLE response handler task with larger stack (3072 bytes)
  xTaskCreatePinnedToCore(
      bleResponseTask,   //  // Task function
      "BLEResponseTask", // Task name
      3072,              // Stack size
      NULL,              // Parameters
      1,                 // Priority
      NULL,              // Task handle
      0                  // Core affinity (PRO_CPU)
  );

  WiFi.mode(WIFI_STA); // Initialize WiFi driver to properly read from NVS
  String savedSSID = wm.getWiFiSSID();

  if (wm.getWiFiSSID() == "" || !wm.getWiFiIsSaved())
  {
    Serial.println("No saved WiFi credentials. Entering provisioning mode...");
    setupBleProvisioning();
  }
  else
  {
    Serial.print("WiFi credentials found for SSID: ");
    Serial.println(savedSSID);
    Serial.println("Connecting to WiFi...");
    if (FORCE_WPA3)
    {
      WiFi.setMinSecurity(WIFI_AUTH_WPA2_WPA3_PSK);
    }
    WiFi.begin(); // Explicitly trigger connection using the saved credentials

    unsigned long start = millis();
    while (millis() - start < WIFI_TIMEOUT && WiFi.status() != WL_CONNECTED)
    {
      Serial.print('.');
      delay(500);
    }
    Serial.println();

    if (WiFi.status() != WL_CONNECTED)
    {
      Serial.println("WiFi did not connect in time. Entering provisioning mode...");
      if (PROVISION_ON_ERROR)
      {
        setupBleProvisioning();
      }
      else
      {
        onboardLed.execute("red");
      }
    }
    else
    {
      dateTimeSyncService.syncTime();

      if (!mqttService.testMqtt())
      {
        Serial.println("MQTT test failed after WiFi connected. Entering provisioning mode...");
        if (PROVISION_ON_ERROR)
        {
          setupBleProvisioning();
        }
        else
        {
          onboardLed.execute("red");
        }
      }
      else
      {
        onboardLed.execute("green");
      }
    }
  }
}

void loop()
{
  delay(100);
  handleReset();
  if (!provisioningMode)
  {
    if (!WiFi.isConnected())
    {
      Serial.println("Not connected to WiFi. Restarting to re-enter provisioning mode...");
      ESP.restart(); // Restart to re-enter provisioning mode if not connected
    }
    else if (!mqttService.loopMqtt())
    {
      Serial.println("MQTT connection lost. Restarting to re-enter provisioning mode...");
      ESP.restart();
    }
    handleTelematryReading();
    loopCommnds();
  }
  else
  {
    handleProvisioningQueue();
  }
  return;
}

void loopCommnds()
{
  size_t actionCount = sizeof(DEVICE_ACTIONS_SETUP) / sizeof(DEVICE_ACTIONS_SETUP[0]);
  for (int i = 0; i < actionCount; i++)
  {
    DEVICE_ACTIONS_SETUP[i]->loop();
  }
}

void performFactoryReset()
{
  Serial.println("Performing factory reset...");
  prefService.ClearCredentials();
  WiFi.mode(WIFI_STA); // Initialize WiFi driver to allow credentials deletion
  wm.resetSettings();  // This handles the WiFi disconnect and credential wipe internally

  Serial.println("Forcing NVS wipe...");
  nvs_flash_deinit();
  nvs_flash_erase();
  nvs_flash_init();

  Serial.println("Factory reset complete. Rebooting...");
  delay(2000); // Debounce and allow serial to flush
  ESP.restart();
}

void handleTelematryReading()
{
  unsigned long currentMillis = millis();

  size_t actionCount = sizeof(TELEMETRY_ACTIONS_SETUP) / sizeof(TELEMETRY_ACTIONS_SETUP[0]);
  for (int i = 0; i < actionCount; i++)
  {
    TELEMETRY_ACTIONS_SETUP[i]->execute(currentMillis, [](const char *topic, const char *payload)
                                        { mqttService.publishTelemetry(topic, payload); });
  }
}

void bleResponseTask(void *pvParameters)
{
  BluetoothResponse bleResponse;

  while (true)
  {
    // Wait for BLE responses to send
    if (xQueueReceive(bleResponseQueue, &bleResponse, pdMS_TO_TICKS(100)) == pdPASS)
    {
      Serial.print("Processing BLE response of type: ");
      Serial.println(static_cast<int>(bleResponse.type));
      Serial.print("Response message: ");
      Serial.println(bleResponse.response);
      if (pCharacteristic != NULL)
      {
        JsonDocument reqDoc;
        bleResponse.toJson(reqDoc); // We know this exists because of JsonModel

        String payloadString;
        serializeJson(reqDoc, payloadString);
        pCharacteristic->setValue((uint8_t *)payloadString.c_str(), payloadString.length());
        pCharacteristic->notify();
        Serial.print("BLE Response status: ");
        Serial.println(static_cast<int>(bleResponse.type));
        Serial.print("BLE Response sent: ");
        Serial.println(bleResponse.response);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void handleReset()
{
  if (digitalRead(BUTTON_PIN) == LOW)
  {
    if (!isPressing)
    {
      buttonPressTime = millis();
      isPressing = true;
    }
    else if (millis() - buttonPressTime > 5000)
    { // 5 second long press
      Serial.println("Long press detected. Initiating factory reset...");
      performFactoryReset();
    }
  }
  else
  {
    isPressing = false;
  }
}

void handleProvisioningQueue()
{
  char *payload = NULL;
  if (xQueueReceive(provisioningQueue, &payload, 0) == pdPASS)
  {
    provisioningBleService.HandleProvisioning(payload);
  }
}

void setupBleProvisioning()
{
  provisioningMode = true;
  onboardLed.execute("blue");
  BLEDevice::init(DEVICE_TYPE);
  BLEServer *pServer = BLEDevice::createServer();
  pServer->setCallbacks(new BleServer());
  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
      CHAR_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY);
  pCharacteristic->setCallbacks(&provisioningCallbacks);
  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("BLE Server started. Waiting for a client to connect...");
}