#pragma once
#include "BleServer.h"
#include <BLEDevice.h>
#include <Arduino.h>

#include "models/BluetoothResponse.h"

class BleNotificationService
{
private:
  BleServer *bleServer;
  QueueHandle_t *bleResponseQueue;

public:
  BleNotificationService(BleServer *bleServer, QueueHandle_t *bleResponseQueue)
      : bleServer(bleServer), bleResponseQueue(bleResponseQueue) {}

  void NotifyBleDevice(ResponseType type, const char *message)
  {
    BluetoothResponse bleResponse(type, message);
    xQueueSend(*bleResponseQueue, &bleResponse, 0);
  }
};