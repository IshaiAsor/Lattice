#pragma once

#include <BLEDevice.h>
#include <Arduino.h>

class BleServer : public BLEServerCallbacks
{
  private:
  bool deviceConnected = false;
  public:
  bool isDeviceConnected()
  {
    return deviceConnected;
  }
  void onConnect(BLEServer *pServer)
  {
    deviceConnected = true;
    Serial.println("BLE Client Connected");
  };

  void onDisconnect(BLEServer *pServer)
  {
    deviceConnected = false;
    Serial.println("BLE Client Disconnected");
    pServer->getAdvertising()->start();
  }
};