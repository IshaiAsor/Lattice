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
#include "services/ProvisioningBleService.h"
#include "actions/DynamicDeviceActionsService.h"
#ifdef HAS_CAMERA
#include "services/LiveStreamService.h"
#include "services/HttpFrameService.h"
#endif
#include "actions/commands/OnboardLedCommandAction.h"
#include "actions/AckPublisher.h"
#include "config/Log.h"

const char* root_ca = certificate_root;

unsigned long buttonPressTime = 0;
unsigned long previousMillis  = 0;

bool isPressing = false;

bool provisioningMode = false;

QueueHandle_t provisioningQueue = NULL;
QueueHandle_t bleResponseQueue  = NULL;

WiFiManager wm;
#ifdef ENV_TEST
WiFiClient espClient;
#else
WiFiClientSecure espClient;
#endif
PreferencesManagerService   prefService;
JwtService                  jwtService;
DateTimeSyncService         dateTimeSyncService;
BleServer                   bleServer;
MqttService                 mqttService(espClient, jwtService);
BleNotificationService      bleNotificationService(&bleServer, &bleResponseQueue);
ProvisioningCallbacks       provisioningCallbacks(&bleNotificationService, &provisioningQueue);
ProvisioningBleService      provisioningBleService(&bleNotificationService, &dateTimeSyncService, &wm, &prefService,
                                                   &jwtService, &mqttService);
BLECharacteristic*          pCharacteristic;
DynamicDeviceActionsService deviceActionsService;
OnboardLedAction            onboardLed("onboardLed", ONBOARD_LED_PIN);

// Command actions report execution here; route it to the device's ack MQTT topic so the
// backend writes the authoritative state only after the device actually executed.
AckPublisherFn ackPublisher = [](const char* actionName, const char* commandId, bool ok, const char* value) {
    mqttService.publishAck(actionName, commandId, ok, value);
};
// Read-surface actions publish their readings here → the device's telemetry topic. Lets the
// MQTT handler route an on-demand `read` without depending on mqtt.h (same cycle-break as ackPublisher).
TelemetryPublisherFn telemetryPublisher = [](const char* actionName, const char* payload) {
    mqttService.publishTelemetry(actionName, payload);
};
#ifdef HAS_CAMERA
// At most one CameraAction per device (see the one-camera-per-device rule), so one shared
// WS connection covers it; HttpFrameService already multiplexes by actionName.
LiveStreamService cameraWsService;
HttpFrameService  httpFrameService;
#endif

void setupBleProvisioning();
void bleResponseTask(void* pvParameters);
void handleProvisioningQueue();
void handleReset();
void performFactoryReset();
void loopActions();
void handleHeartbeat();

void setup()
{
    Serial.begin(115200);
#ifdef ARDUINO_USB_CDC_ON_BOOT
    uint32_t t = millis();
    while (!Serial && (millis() - t) < 3000)
        delay(10);
#endif

    LOG_I("Boot", "device starting — type=%s version=%s", DEVICE_TYPE, DEVICE_VERSION);

#ifdef BOARD_HAS_PSRAM
    if (psramFound())
    {
        // Route malloc() >= 4 KB to PSRAM so mbedTLS SSL buffers (~60 KB) don't
        // compete with fragmented internal DRAM.
        heap_caps_malloc_extmem_enable(4096);
        LOG_I("Boot", "PSRAM OK: %u bytes free", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
    else
    {
        LOG_W("Boot", "PSRAM not found — SSL connections may fail");
    }
    LOG_I("Boot", "internal DRAM free: %u bytes", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
#endif

    if (digitalRead(BUTTON_PIN) == LOW)
    {
        LOG_I("Boot", "boot button press detected — initiating factory reset");
        performFactoryReset();
    }

    onboardLed.initPins();
    onboardLed.execute("orange");

    provisioningQueue = xQueueCreate(1, sizeof(char*));
    bleResponseQueue  = xQueueCreate(5, sizeof(BluetoothResponse));

    if (provisioningQueue == NULL || bleResponseQueue == NULL)
    {
        LOG_E("Boot", "could not create FreeRTOS queues");
    }

    // Create BLE response handler task with larger stack (3072 bytes)
    xTaskCreatePinnedToCore(bleResponseTask,   // Task function
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
        LOG_I("Boot", "no saved WiFi credentials — entering provisioning mode");
        setupBleProvisioning();
    }
    else
    {
        LOG_I("Boot", "WiFi credentials found for SSID: %s — connecting", savedSSID.c_str());
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
            LOG_W("Boot", "WiFi did not connect in time — entering provisioning mode");
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

            JwtToken*        jwtData = jwtService.GetCurrentJwtToken();
            MqttCredentials* creds   = prefService.LoadMqttServerCredentials();

            if (jwtData && jwtData->deviceConfigUrl.isEmpty())
            {
                LOG_W("Boot", "device config URL missing — re-provisioning required");
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
                LOG_W("Boot", "MQTT test failed after WiFi connected — entering provisioning mode");
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
                    LOG_E("Boot", "failed to load device configuration — restarting in 5s");
                    onboardLed.execute("red");
                    delay(5000);
                    ESP.restart();
                }

                // Initialize pins then restore last saved state (loadState is a no-op for
                // read-only actions, so the unified list is walked once).
                for (size_t i = 0; i < deviceActionsService.getActionsCount(); i++)
                {
                    deviceActionsService.getActions()[i]->initPins();
                    deviceActionsService.getActions()[i]->loadState();
                }

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
            LOG_W("Boot", "WiFi disconnected — restarting to re-enter provisioning mode");
            ESP.restart();
        }
        else if (!mqttService.loopMqtt())
        {
            LOG_W("Boot", "MQTT connection lost — restarting to re-enter provisioning mode");
            ESP.restart();
        }
        loopActions();
        handleHeartbeat();
    }
    else
    {
        handleProvisioningQueue();
    }
    return;
}

// One pass over the unified action list each tick: telemetry actions do their interval reads
// (publishing via the callback), command actions do duration auto-off. Replaces the old
// split handleTelemetryReading()/loopCommands() now that both surfaces share DeviceAction.
void loopActions()
{
    unsigned long now = millis();
    for (size_t i = 0; i < deviceActionsService.getActionsCount(); i++)
        deviceActionsService.getActions()[i]->tick(now, telemetryPublisher);
}

void handleHeartbeat()
{
    static unsigned long lastHeartbeat = 0;
    unsigned long        now           = millis();
    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS)
    {
        lastHeartbeat = now;
        mqttService.publishHeartbeat();
    }
}

void performFactoryReset()
{
    LOG_I("Reset", "performing factory reset");
    prefService.ClearCredentials();
    WiFi.mode(WIFI_STA);
    wm.resetSettings();

    LOG_I("Reset", "forcing NVS wipe");
    nvs_flash_deinit();
    nvs_flash_erase();
    nvs_flash_init();

    LOG_I("Reset", "factory reset complete — rebooting");
    delay(2000);
    ESP.restart();
}

void bleResponseTask(void* pvParameters)
{
    BluetoothResponse bleResponse;

    while (true)
    {
        if (xQueueReceive(bleResponseQueue, &bleResponse, pdMS_TO_TICKS(100)) == pdPASS)
        {
            LOG_D("Ble", "processing response type=%d message=%s", static_cast<int>(bleResponse.type),
                  bleResponse.response);
            if (pCharacteristic != NULL)
            {
                JsonDocument reqDoc;
                bleResponse.toJson(reqDoc);

                String payloadString;
                serializeJson(reqDoc, payloadString);
                pCharacteristic->setValue((uint8_t*)payloadString.c_str(), payloadString.length());
                pCharacteristic->notify();
                LOG_D("Ble", "response sent (type=%d)", static_cast<int>(bleResponse.type));
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
            isPressing      = true;
        }
        else
        {
            unsigned long pressDuration = millis() - buttonPressTime;
            if (pressDuration > 10000)
            {
                LOG_I("Reset", "10s press detected — initiating factory reset");
                performFactoryReset();
            }
            else if (pressDuration > 5000 && !provisioningMode)
            {
                LOG_I("Reset", "5s press detected — entering provisioning mode");
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
    char* payload = NULL;
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
    BLEServer* pServer = BLEDevice::createServer();
    pServer->setCallbacks(new BleServer());
    BLEService* pService = pServer->createService(SERVICE_UUID);
    pCharacteristic      = pService->createCharacteristic(CHAR_UUID, BLECharacteristic::PROPERTY_WRITE |
                                                                         BLECharacteristic::PROPERTY_NOTIFY);
    pCharacteristic->setCallbacks(&provisioningCallbacks);
    pCharacteristic->addDescriptor(new BLE2902());
    pService->start();
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    BLEDevice::startAdvertising();
    LOG_I("Ble", "BLE server started — waiting for a client to connect");
}
