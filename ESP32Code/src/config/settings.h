#pragma once
const char DEVICE_TYPE[] = "ESP32_SmartOutlet";
const char DEVICE_VERSION[] = "V1.0.0";
const char COMMAND_TOPIC[] = "users/%{userid}/devices/%{deviceid}/command/#";
const char STATUS_TOPIC[] = "users/%{userid}/devices/%{deviceid}/status";
const char TELEMETRY_TOPIC[] = "users/%{userid}/devices/%{deviceid}/telemetry/#";
const char AP_HOTSPOT_NAME[] = "SmartOutlet_Setup";
const char AP_HOTSPOT_PASSWORD[] = ""; // Open network for easier provisioning
const char SERVICE_UUID[] = "12345678-1234-5678-1234-56789abcdef0";
const char CHAR_UUID[] = "abcdef01-1234-5678-1234-56789abcdef0";
const int BUTTON_PIN = 0;
const int READING_INTERVAL = 10000; // 10 seconds
const long JWT_REFRESH_POLICY = 60 * 7.5;
const bool FORCE_WPA3 = false;
const bool PROVISION_ON_ERROR=false;
const long WIFI_TIMEOUT = 1000*60*60; //60 min
