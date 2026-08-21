#include <Arduino.h>
#include <cstring>
#include <cstdlib>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <NimBLEDevice.h>
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
#include "services/CameraSelfTest.h"
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

// Set by buttonTask when a 5s press asks for provisioning. A flag rather than a direct call
// because BLE must be brought up on the main task, not from an arbitrary FreeRTOS context.
volatile bool provisionRequested = false;

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
NimBLECharacteristic*       pCharacteristic;
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
void buttonTask(void* pv);
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

    // CORE_DEBUG_LEVEL only sets the compile-time ceiling; ESP-IDF components still gate their
    // own ESP_LOGx at runtime, and the default runtime level hides them. Opening it up here is
    // what makes the esp32-camera driver say *why* esp_camera_fb_get() returned null (FB-OVF,
    // "Failed to get the frame on time!", DMA alloc failures) instead of failing mutely.
    esp_log_level_set("*", ESP_LOG_VERBOSE);

#if defined(HAS_CAMERA) && defined(CAMERA_SELFTEST)
    // Deliberately the first thing after Serial: the whole point is to exercise the camera
    // before WiFi, BLE, TLS or MQTT can contend for DMA, heap or GPIO.
    CameraSelfTest::run();
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

    // The button gets its own task, started before any blocking work. setup() can spend up to
    // WIFI_TIMEOUT (60 min) busy-waiting on a saved-but-unusable network, and loop() — the only
    // thing that used to sample the button — does not run until setup() returns. That left the
    // device deaf to both the 5s provisioning press and the 10s factory reset for the whole wait,
    // with no way back other than a reflash.
    xTaskCreatePinnedToCore(buttonTask, "ButtonTask", 2560, NULL, 2, NULL, 0);

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
        while (millis() - start < WIFI_TIMEOUT && WiFi.status() != WL_CONNECTED && !provisionRequested)
        {
            Serial.print('.');
            delay(500);
        }
        Serial.println();

        // A held button outranks the wait: the user is telling us this network is not going to
        // work, and an hour of dots is not an answer.
        if (provisionRequested)
        {
            LOG_I("Boot", "provisioning requested by button — abandoning WiFi wait");
            provisionRequested = false;
            setupBleProvisioning();
        }
        else if (WiFi.status() != WL_CONNECTED)
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
    // buttonTask owns the pin; this only acts on what it decided, so BLE is still brought up on
    // the main task.
    if (provisionRequested)
    {
        provisionRequested = false;
        if (!provisioningMode)
        {
            LOG_I("Reset", "provisioning requested by button");
            setupBleProvisioning();
        }
    }
    onboardLed.loop();
    if (provisioningMode)
    {
        handleProvisioningQueue();
        return;
    }

    // Nothing to retry until someone re-provisions; buttonTask runs independently of this loop,
    // so a long press still starts provisioning (or factory-resets) from here.
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

/**
 * Owns the button, on its own task, for the life of the device.
 *
 * It used to be polled from loop(), which meant it stopped working exactly when it was needed
 * most: setup() busy-waits up to WIFI_TIMEOUT (60 min) on a saved network that may be gone, and
 * loop() does not start until that returns. A device that could not reach its AP was unreachable
 * by button too, leaving a reflash as the only way back.
 *
 * Factory reset runs here directly — it wipes NVS and reboots, so there is nothing left to
 * coordinate. Provisioning only raises a flag, because BLE has to be started on the main task.
 */
void buttonTask(void* pv)
{
    (void)pv;
    bool          pressing  = false;
    bool          actioned  = false; // one action per press, so a long hold cannot fire twice
    unsigned long pressedAt = 0;

    for (;;)
    {
        if (digitalRead(BUTTON_PIN) == LOW)
        {
            if (!pressing)
            {
                pressing  = true;
                actioned  = false;
                pressedAt = millis();
            }
            else if (!actioned)
            {
                unsigned long held = millis() - pressedAt;
                if (held > 10000)
                {
                    actioned = true;
                    LOG_I("Reset", "10s press detected — initiating factory reset");
                    performFactoryReset();
                }
                else if (held > 5000 && !provisioningMode)
                {
                    actioned = true;
                    LOG_I("Reset", "5s press detected — requesting provisioning mode");
                    provisionRequested = true;
                }
            }
        }
        else
        {
            pressing = false;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
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
    NimBLEDevice::init(DEVICE_TYPE);
    NimBLEServer* pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new BleServer());
    NimBLEService* pService = pServer->createService(SERVICE_UUID);
    pCharacteristic = pService->createCharacteristic(CHAR_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
    pCharacteristic->setCallbacks(&provisioningCallbacks);
    // No explicit 0x2902 descriptor: NimBLE creates the CCCD itself for any characteristic that
    // declares NOTIFY, and adding one by hand produces a duplicate the client can subscribe to
    // but that the stack never writes. This is the Bluedroid `new BLE2902()` line, deleted.
    pService->start();
    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->enableScanResponse(true);
    // NimBLEDevice::init() only sets the GAP device-name characteristic, which a central can read
    // *after* connecting. Bluedroid additionally put the name in the advertisement; NimBLE does
    // not, so without this the browser's pairing dialog lists the device as "Unknown or
    // Unsupported Device (<MAC>)". Must come after enableScanResponse: setName() prefers the scan
    // response, and it has to go there — the 128-bit service UUID already eats 18 of the 31
    // advertising bytes, which no DEVICE_TYPE of ours fits alongside.
    if (!pAdvertising->setName(DEVICE_TYPE))
    {
        LOG_W("Ble", "advertised name did not fit — device will show as unnamed");
    }
    NimBLEDevice::startAdvertising();
    LOG_I("Ble", "BLE server started — waiting for a client to connect");
}

#ifdef FREE_BLE_BEFORE_TLS
#include <esp_bt.h> // esp_bt_controller_mem_release — see the note in teardownBleForTls
// Classic ESP32 (no PSRAM) could not hold the BLE stack AND mbedTLS's ~40 KB of SSL record
// buffers at once — the provisioning TLS handshake died with MBEDTLS_ERR_SSL_ALLOC_FAILED
// (-0x7F00). Provisioning restarts the device on both success and failure, so once WiFi creds
// + the provisioning token are in hand BLE has no job left: release the whole stack to reclaim
// the heap the handshakes need. Called by ProvisioningBleService right before the MQTT probe /
// provision call. Idempotent.
//
// This was written against Bluedroid. NimBLE's host needs substantially less RAM, so the
// original allocation failure may no longer be reachable — but that is a claim about heap on a
// real board, so the teardown stays until provisioning TLS has been re-tested on classic-ESP32
// hardware under NimBLE. See F3.19.
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
    pCharacteristic = NULL;     // freed by deinit below — must not be dereferenced after this
    NimBLEDevice::deinit(true); // stops the host and disables + deinits the BT controller

    // NimBLE's deinit stops there. Bluedroid's deinit(true) went one step further and called
    // esp_bt_controller_mem_release(), which is what actually hands the controller's static BT
    // memory back to the heap — and that heap is the entire reason this function exists. Without
    // it the swap would quietly give back less than it used to, on the one board that cannot
    // spare it. The controller is already deinited above, which is the precondition; if it is
    // not, this returns an error rather than crashing. Safe because provisioning reboots the
    // device on both success and failure, so BLE is never needed again this boot.
    esp_err_t memRc = esp_bt_controller_mem_release(ESP_BT_MODE_BTDM);
    if (memRc != ESP_OK)
    {
        LOG_W("Ble", "controller mem release failed (%d) — TLS may be short on heap", memRc);
    }
    LOG_I("Ble", "BLE released (free heap %u)", ESP.getFreeHeap());
}
#endif
