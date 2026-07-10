#pragma once

#include <BLEDevice.h>
#include <Arduino.h>
#include "config/Log.h"

class BleServer : public BLEServerCallbacks
{
  private:
    bool deviceConnected = false;

  public:
    bool isDeviceConnected() { return deviceConnected; }
    void onConnect(BLEServer* pServer)
    {
        deviceConnected = true;
        LOG_I("Ble", "client connected");
    };

    void onDisconnect(BLEServer* pServer)
    {
        deviceConnected = false;
        LOG_I("Ble", "client disconnected");
        pServer->getAdvertising()->start();
    }
};