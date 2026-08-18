#pragma once

#include <NimBLEDevice.h>
#include <Arduino.h>
#include "config/Log.h"

class BleServer : public NimBLEServerCallbacks
{
  private:
    bool deviceConnected = false;

  public:
    bool isDeviceConnected() { return deviceConnected; }

    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) override
    {
        deviceConnected = true;
        LOG_I("Ble", "client connected");
    };

    // NimBLE stops advertising on connect and does not resume on its own, same as Bluedroid did.
    // Restart through NimBLEDevice rather than the server handle — in NimBLE advertising is owned
    // by the device singleton, not the server.
    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override
    {
        deviceConnected = false;
        LOG_I("Ble", "client disconnected (reason %d)", reason);
        NimBLEDevice::startAdvertising();
    }
};
