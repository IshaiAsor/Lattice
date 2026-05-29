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
MqttService mqttService(espClient, jwtService);
BleNotificationService bleNotificationService(&bleServer, &bleResponseQueue);
ProvisioningCallbacks provisioningCallbacks(&bleNotificationService, &provisioningQueue);
ProvisioningBleService provisioningBleService(&bleNotificationService, &dateTimeSyncService, &wm, &prefService, &jwtService, &mqttService);
BLECharacteristic *pCharacteristic;
DynamicDeviceActionsService deviceActionsService;

void setupBleProvisioning();
void bleResponseTask(void *pvParameters);
void handleTelametryReading();
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

  onboardLed.initPins();
  onboardLed.execute("orange");

  provisioningQueue = xQueueCreate(1, sizeof(char *));
  bleResponseQueue = xQueueCreate(5, sizeof(BluetoothResponse));

  if (provisioningQueue == NULL || bleResponseQueue == NULL)
  {
    Serial.println("ERROR: Could not create queues!");
  }

  // Create BLE response handler task with larger stack (3072 bytes)
  xTaskCreatePinnedToCore(
      bleResponseTask,   // Task function
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

      JwtToken *jwtData = jwtService.GetCurrentJwtToken();
      MqttCredentials *creds = prefService.LoadMqttServerCredentials();

      // Verify the device config URL was set during provisioning.
      // Missing URL means the device was provisioned before this feature was added — re-provision to get it.
      if (jwtData && jwtData->deviceConfigUrl.isEmpty())
      {
        Serial.println("Device config URL missing — re-provisioning required.");
        if (PROVISION_ON_ERROR)
        {
          setupBleProvisioning();
        }
        else
        {
          onboardLed.execute("red");
        }
      }
      else if (!creds || !jwtData || !mqttService.testMqtt(creds, jwtData))
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
        // Load device actions from server — no fallback; restart if unavailable
        if (!deviceActionsService.loadFromServer(jwtData))
        {
          Serial.println("[Config] Failed to load device configuration. Restarting in 5s...");
          onboardLed.execute("red");
          delay(5000);
          ESP.restart();
        }

        // Initialize pins on all dynamically loaded actions
        for (size_t i = 0; i < deviceActionsService.getDeviceActionsCount(); i++)
          deviceActionsService.getDeviceActions()[i]->initPins();
        for (size_t i = 0; i < deviceActionsService.getTelemetryActionsCount(); i++)
          deviceActionsService.getTelemetryActions()[i]->initPins();

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
      ESP.restart();
    }
    else if (!mqttService.loopMqtt())
    {
      Serial.println("MQTT connection lost. Restarting to re-enter provisioning mode...");
      ESP.restart();
    }
    handleTelametryReading();
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
  for (size_t i = 0; i < deviceActionsService.getDeviceActionsCount(); i++)
    deviceActionsService.getDeviceActions()[i]->loop();
}

void performFactoryReset()
{
  Serial.println("Performing factory reset...");
  prefService.ClearCredentials();
  WiFi.mode(WIFI_STA);
  wm.resetSettings();

  Serial.println("Forcing NVS wipe...");
  nvs_flash_deinit();
  nvs_flash_erase();
  nvs_flash_init();

  Serial.println("Factory reset complete. Rebooting...");
  delay(2000);
  ESP.restart();
}

void handleTelametryReading()
{
  unsigned long currentMillis = millis();
  for (size_t i = 0; i < deviceActionsService.getTelemetryActionsCount(); i++)
  {
    deviceActionsService.getTelemetryActions()[i]->execute(currentMillis,
      [](const char *topic, const char *payload) {
        mqttService.publishTelemetry(topic, payload);
      });
  }
}

void bleResponseTask(void *pvParameters)
{
  BluetoothResponse bleResponse;

  while (true)
  {
    if (xQueueReceive(bleResponseQueue, &bleResponse, pdMS_TO_TICKS(100)) == pdPASS)
    {
      Serial.print("Processing BLE response of type: ");
      Serial.println(static_cast<int>(bleResponse.type));
      Serial.print("Response message: ");
      Serial.println(bleResponse.response);
      if (pCharacteristic != NULL)
      {
        JsonDocument reqDoc;
        bleResponse.toJson(reqDoc);

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
    {
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
