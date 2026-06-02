#pragma once
#ifndef DEVICE_TYPE_STR
#error "DEVICE_TYPE_STR must be defined in build_flags (e.g. -D DEVICE_TYPE_STR=\"ESP32S3_Mini\")"
#endif
#pragma once
#ifndef DEVICE_VERSION_STR
#error "DEVICE_VERSION_STR must be defined in build_flags (e.g. -D DEVICE_VERSION_STR=\"V1.0.0\")"
#endif
const char DEVICE_TYPE[] = DEVICE_TYPE_STR;
const char DEVICE_VERSION[] = DEVICE_VERSION_STR;
const char COMMAND_TOPIC[] = "users/%{userid}/devices/%{deviceid}/%{version}/command/#";
const char STATUS_TOPIC[] = "users/%{userid}/devices/%{deviceid}/%{version}/status";
const char TELEMETRY_TOPIC[] = "users/%{userid}/devices/%{deviceid}/%{version}/telemetry/#";
const char OTA_TOPIC[] = "ota/updates/%{devicetype}";
const char AP_HOTSPOT_NAME[] = "SmartOutlet_Setup";
const char AP_HOTSPOT_PASSWORD[] = ""; // Open network for easier provisioning
const char SERVICE_UUID[] = "12345678-1234-5678-1234-56789abcdef0";
const char CHAR_UUID[] = "abcdef01-1234-5678-1234-56789abcdef0";
const int BUTTON_PIN = 0;
const int READING_INTERVAL = 10000; // 10 seconds
const long JWT_REFRESH_POLICY = 60 * 7.5;
const bool FORCE_WPA3 = false;
const bool PROVISION_ON_ERROR=true;
const long WIFI_TIMEOUT = 1000*60*60; //60 min
