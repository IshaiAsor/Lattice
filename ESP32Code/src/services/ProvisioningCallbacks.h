#pragma once
#include "BleNotificationService.h"
#include "config/Log.h"
class ProvisioningCallbacks : public BLECharacteristicCallbacks
{
  private:
    BleNotificationService* bleNotificationService;
    QueueHandle_t*          provisioningQueue = NULL;

  public:
    ProvisioningCallbacks(BleNotificationService* bleNotificationService, QueueHandle_t* provisioningQueue)
        : bleNotificationService(bleNotificationService), provisioningQueue(provisioningQueue)
    {
    }

    void onWrite(BLECharacteristic* pCharacteristic)
    {
        std::string value = pCharacteristic->getValue();

        if (value.length() > 0)
        {
            LOG_D("Ble", "received data over BLE");

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