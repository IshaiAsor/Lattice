#include <Arduino.h>
#include <cstring>
#include <cstdlib>
#include <esp_heap_caps.h>
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
#include "services/ProvisioningBleService.h"
#include "actions/DynamicDeviceActionsService.h"
#ifdef HAS_CAMERA
#include "services/LiveStreamService.h"
#include "services/HttpFrameService.h"
#endif
#include "actions/commands/OnboardLedCommandAction.h"
const char *root_ca = certificate_root;

unsigned long buttonPressTime = 0;
unsigned long previousMillis = 0;

bool isPressing = false;

bool provisioningMode = false;

QueueHandle_t provisioningQueue = NULL;
QueueHandle_t bleResponseQueue = NULL;

WiFiManager wm;
#ifdef ENV_TEST
WiFiClient espClient;
#else
WiFiClientSecure espClient;
#endif
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
extern OnboardLedAction onboardLed;
#ifdef HAS_CAMERA
LiveStreamService liveStreamService;
LiveStreamService wsCaptureService;
HttpFrameService httpFrameService;
#endif

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
#ifdef ARDUINO_USB_CDC_ON_BOOT
  uint32_t t = millis();
  while (!Serial && (millis() - t) < 3000)
    delay(10);
#endif

  Serial.println("Device Starting...");
  Serial.print("Device Type: ");
  Serial.println(DEVICE_TYPE);
  Serial.print("Firmware Version: ");
  Serial.println(DEVICE_VERSION);

#ifdef BOARD_HAS_PSRAM
  if (psramFound())
  {
    // Route malloc() >= 4 KB to PSRAM so mbedTLS SSL buffers (~60 KB) don't
    // compete with fragmented internal DRAM.
    heap_caps_malloc_extmem_enable(4096);
    Serial.printf("PSRAM OK: %u bytes free\n", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
  }
  else
  {
    Serial.println("PSRAM NOT FOUND - SSL connections may fail");
  }
  Serial.printf("Internal DRAM free: %u bytes\n", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
#endif

  if (digitalRead(BUTTON_PIN) == LOW)
  {
    Serial.println("Boot button press detected. Initiating factory reset...");
    performFactoryReset();
  }

  // Initialize the global onboardLed defined in DynamicDeviceActionsService.h
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

        // Initialize pins then restore last saved state for command actions
        for (size_t i = 0; i < deviceActionsService.getDeviceActionsCount(); i++)
        {
          deviceActionsService.getDeviceActions()[i]->initPins();
          deviceActionsService.getDeviceActions()[i]->loadState();
        }
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
  onboardLed.loop();
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
                                                           [](const char *topic, const char *payload)
                                                           {
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
    else
    {
      unsigned long pressDuration = millis() - buttonPressTime;
      if (pressDuration > 10000)
      {
        Serial.println("10s press detected. Initiating factory reset...");
        performFactoryReset();
      }
      else if (pressDuration > 5000 && !provisioningMode)
      {
        Serial.println("5s press detected. Entering provision mode...");
        setupBleProvisioning();
      }
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
