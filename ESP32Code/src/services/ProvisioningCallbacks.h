#pragma once
#include "BleNotificationService.h"
class ProvisioningCallbacks : public BLECharacteristicCallbacks
{
  private:
    BleNotificationService *bleNotificationService;
    QueueHandle_t *provisioningQueue = NULL;
  public:
    ProvisioningCallbacks(BleNotificationService *bleNotificationService, QueueHandle_t *provisioningQueue)
    : bleNotificationService(bleNotificationService), provisioningQueue(provisioningQueue) {}


  void onWrite(BLECharacteristic *pCharacteristic)
  {
    std::string value = pCharacteristic->getValue();

    if (value.length() > 0)
    {
      Serial.println("Received data over BLE");

      char *payload = (char *)malloc(value.size() + 1);
      if (payload == NULL)
      {
        Serial.println("Failed to allocate memory for provisioning payload");
        bleNotificationService->NotifyBleDevice(ResponseType::WIFI_ERROR, "FAIL: MALLOC_ERROR");
        return;
      }
      memcpy(payload, value.c_str(), value.size() + 1);

      if (xQueueSend(*provisioningQueue, &payload, pdMS_TO_TICKS(1000)) != pdPASS)
      {
        Serial.println("Failed to queue provisioning data");
        free(payload);
        bleNotificationService->NotifyBleDevice(ResponseType::WIFI_ERROR, "FAIL: QUEUE_ERROR");
        return;
      }

      Serial.println("Provisioning payload queued for processing in main task...");
    }
  }


};