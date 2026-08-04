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

// Set only when storage holds nothing to connect with — the one boot outcome that genuinely
// needs a human. Everything else (no AP, no broker, no WAN) is retried indefinitely.
bool needsProvisioning = false;

// The served config arrives over the network, so it is retried rather than required at boot.
bool          deviceConfigLoaded = false;
unsigned long configRetryAt      = 0;
unsigned long configRetryBackoff = CONFIG_RETRY_MIN_MS;
unsigned long wifiRetryAt        = 0;

QueueHandle_t provisioningQueue = NULL;
QueueHandle_t bleResponseQueue  = NULL;

// Stored so the BLE stack can be torn down before the provisioning TLS phase on low-heap
// boards (see teardownBleForTls, gated by FREE_BLE_BEFORE_TLS).
TaskHandle_t bleResponseTaskHandle = NULL;

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
bool ensureWifi();
bool ensureDeviceConfig();
void updateStatusLed(bool healthy);

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
    xTaskCreatePinnedToCore(bleResponseTask,        // Task function
                            "BLEResponseTask",      // Task name
                            3072,                   // Stack size
                            NULL,                   // Parameters
                            1,                      // Priority
                            &bleResponseTaskHandle, // Task handle (kept for teardownBleForTls)
                            0                       // Core affinity (PRO_CPU)
    );

    WiFi.mode(WIFI_STA); // Initialize WiFi driver to properly read from NVS
    // Let the driver re-associate on its own when the AP comes back (nightly router restart);
    // ensureWifi() only nudges it if that stalls.
    WiFi.setAutoReconnect(true);
    WiFi.persistent(true);
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
            // Bounded — an unreachable NTP server (router LAN up, WAN not yet) must not hold
            // boot hostage. Proceeds unsynced; DateTimeSyncService::loop() keeps retrying.
            dateTimeSyncService.syncTime();

            // Read what storage actually holds. Only this decides "needs a human": it is a
            // pure NVS read, unlike anything that can fail merely because the network is late.
            MqttCredentials* creds   = prefService.LoadMqttServerCredentials();
            JwtToken*        jwtData = jwtService.GetCurrentJwtToken();

            if (!creds || (jwtData != nullptr && jwtData->deviceConfigUrl.isEmpty()))
            {
                LOG_W("Boot", "no usable stored provisioning — device must be re-provisioned");
                needsProvisioning = true;
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
                // Everything below depends on the network, so none of it is fatal at boot: a
                // router that is still coming back up just means loop() retries on backoff.
                // The device keeps its credentials and its relay state throughout.
                if (!mqttService.loopMqtt())
                    LOG_W("Boot", "broker not reachable yet — retrying in the background");

                if (!ensureDeviceConfig())
                    LOG_W("Boot", "device config not loaded yet — retrying in the background");

                updateStatusLed(deviceConfigLoaded && mqttService.connected());
            }
        }
    }
}

void loop()
{
    delay(100);
    handleReset();
    onboardLed.loop();
    if (provisioningMode)
    {
        handleProvisioningQueue();
        return;
    }

    // Nothing to retry until someone re-provisions; handleReset() above still serves the
    // button, so a long press can start provisioning.
    if (needsProvisioning)
        return;

    dateTimeSyncService.loop();

    // A dropped AP or an unreachable broker are wait-and-retry conditions. They used to
    // reboot the device — which, with the credential wipe that followed, turned a nightly
    // router restart into permanent loss of provisioning.
    if (!ensureWifi())
    {
        updateStatusLed(false);
        return;
    }

    bool mqttUp = mqttService.loopMqtt();
    bool cfgUp  = mqttUp ? ensureDeviceConfig() : deviceConfigLoaded;
    updateStatusLed(mqttUp && cfgUp);

    loopActions();
    handleHeartbeat();
}

// Re-associate with backoff. The driver's own auto-reconnect handles the common case; this
// nudges it when it stalls and keeps the rest of the loop from running against a dead link.
bool ensureWifi()
{
    if (WiFi.isConnected())
    {
        if (wifiRetryAt != 0)
        {
            LOG_I("Wifi", "reconnected — IP %s", WiFi.localIP().toString().c_str());
            wifiRetryAt = 0;
        }
        return true;
    }

    unsigned long now = millis();
    if (wifiRetryAt != 0 && (long)(now - wifiRetryAt) < 0) // rollover-safe compare
        return false;

    LOG_W("Wifi", "disconnected — re-associating");
    WiFi.reconnect();
    wifiRetryAt = now + WIFI_RETRY_INTERVAL_MS;
    return false;
}

// Fetch the served config once it's reachable. Retried on a widening backoff instead of
// being a boot-time hard requirement: rebooting on a failed fetch only produces a reboot
// loop for as long as the WAN is down.
bool ensureDeviceConfig()
{
    if (deviceConfigLoaded)
        return true;

    unsigned long now = millis();
    if (configRetryAt != 0 && (long)(now - configRetryAt) < 0) // rollover-safe compare
        return false;

    JwtToken* jwtData = jwtService.GetCurrentJwtToken();
    if (jwtData != nullptr && deviceActionsService.loadFromServer(jwtData))
    {
        // Initialize pins then restore last saved state (loadState is a no-op for
        // read-only actions, so the unified list is walked once).
        for (size_t i = 0; i < deviceActionsService.getActionsCount(); i++)
        {
            deviceActionsService.getActions()[i]->initPins();
            deviceActionsService.getActions()[i]->loadState();
        }

        deviceConfigLoaded = true;
        configRetryAt      = 0;
        configRetryBackoff = CONFIG_RETRY_MIN_MS;
        LOG_I("Boot", "device configuration loaded (%u actions)",
              static_cast<unsigned>(deviceActionsService.getActionsCount()));
        return true;
    }

    configRetryAt = now + configRetryBackoff;
    LOG_W("Boot", "failed to load device configuration — next attempt in %lu ms", configRetryBackoff);
    configRetryBackoff = (configRetryBackoff > CONFIG_RETRY_MAX_MS / 2) ? CONFIG_RETRY_MAX_MS : configRetryBackoff * 2;
    return false;
}

// Reflect connectivity without re-issuing the same LED command on every tick.
void updateStatusLed(bool healthy)
{
    static int last = -1;
    int        want = healthy ? 1 : 0;
    if (want == last)
        return;
    last = want;
    onboardLed.execute(healthy ? "green" : "orange");
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

#ifdef FREE_BLE_BEFORE_TLS
// Classic ESP32 (no PSRAM) can't hold the Bluedroid stack AND mbedTLS's ~40 KB of SSL
// record buffers at once — the provisioning TLS handshake dies with
// MBEDTLS_ERR_SSL_ALLOC_FAILED (-0x7F00). Provisioning restarts the device on both success
// and failure, so once WiFi creds + the provisioning token are in hand BLE has no job left:
// release the whole stack to reclaim the heap the handshakes need. Called by
// ProvisioningBleService right before the MQTT probe / provision call. Idempotent.
void teardownBleForTls()
{
    static bool torn = false;
    if (torn)
        return;
    torn = true;

    LOG_I("Ble", "releasing BLE stack before TLS (free heap %u)", ESP.getFreeHeap());
    if (bleResponseTaskHandle != NULL)
    {
        vTaskDelete(bleResponseTaskHandle); // no more notifies will touch the characteristic
        bleResponseTaskHandle = NULL;
    }
    pCharacteristic = NULL;  // freed by deinit below — must not be dereferenced after this
    BLEDevice::deinit(true); // release Bluedroid + BT controller memory back to the heap
    LOG_I("Ble", "BLE released (free heap %u)", ESP.getFreeHeap());
}
#endif
