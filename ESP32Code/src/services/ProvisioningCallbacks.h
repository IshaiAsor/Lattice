#pragma once
#include "BleNotificationService.h"
#include "config/Log.h"
class ProvisioningCallbacks : public NimBLECharacteristicCallbacks
{
  private:
    BleNotificationService* bleNotificationService;
    QueueHandle_t*          provisioningQueue = NULL;

  public:
    ProvisioningCallbacks(BleNotificationService* bleNotificationService, QueueHandle_t* provisioningQueue)
        : bleNotificationService(bleNotificationService), provisioningQueue(provisioningQueue)
    {
    }

    // NimBLE hands the connection info to every characteristic callback; unused here, but the
    // signature has to match or the override is silently never called.
    void onWrite(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) override
    {
        // NimBLEAttValue rather than std::string: it is the stack's own buffer, so this avoids a
        // copy of the payload on the BLE task's stack. c_str() is NUL-terminated, as memcpy below
        // assumes.
        NimBLEAttValue value = pCharacteristic->getValue();

        if (value.length() > 0)
        {
            // Length matters here: a characteristic value is capped at 512 bytes (BLE's ATT
            // ceiling, not a NimBLE limit), and the provisioning payload — JWT included — lands
            // close to it. A payload that reached this callback truncated would fail as a JSON
            // parse error further down, which would not point at the real cause. Compiles out
            // in prod (INFO).
            LOG_D("Ble", "received %u bytes over BLE (attribute ceiling 512)", static_cast<unsigned>(value.length()));

            char* payload = (char*)malloc(value.size() + 1);
            if (payload == NULL)
            {
                LOG_E("Ble", "failed to allocate memory for provisioning payload");
                bleNotificationService->NotifyBleDevice(ResponseType::WIFI_ERROR, "FAIL: MALLOC_ERROR");
                return;
            }
            memcpy(payload, value.c_str(), value.size() + 1);

            if (xQueueSend(*provisioningQueue, &payload, pdMS_TO_TICKS(1000)) != pdPASS)
            {
                LOG_E("Ble", "failed to queue provisioning data");
                free(payload);
                bleNotificationService->NotifyBleDevice(ResponseType::WIFI_ERROR, "FAIL: QUEUE_ERROR");
                return;
            }

            LOG_D("Ble", "provisioning payload queued for main task");
        }
    }
};