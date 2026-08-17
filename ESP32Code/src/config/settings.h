#pragma once
#include <time.h>
#ifndef DEVICE_TYPE_STR
#error "DEVICE_TYPE_STR must be defined in build_flags (e.g. -D DEVICE_TYPE_STR=\"ESP32S3_Mini\")"
#endif
#ifndef DEVICE_VERSION_STR
#error "DEVICE_VERSION_STR must be defined in build_flags (e.g. -D DEVICE_VERSION_STR=\"V1.0.0\")"
#endif
const char DEVICE_TYPE[]    = DEVICE_TYPE_STR;
const char DEVICE_VERSION[] = DEVICE_VERSION_STR;
// SEALED = factory-soldered device. The build flag (-D SEALED) marks the type is_sealed in the
// catalog (via the manifest), so its pins/actions come from an admin-composed template and the
// user configures nothing. Runtime config consumption is unchanged — the device still pulls its
// served config by (type, version); this constant only records intent.
#ifdef SEALED
[[maybe_unused]] const bool DEVICE_IS_SEALED = true;
#else
[[maybe_unused]] const bool DEVICE_IS_SEALED = false;
#endif
const char COMMAND_TOPIC[]       = "users/%{userid}/devices/%{deviceid}/%{version}/command/#";
const char STATUS_TOPIC[]        = "users/%{userid}/devices/%{deviceid}/%{version}/status";
const char TELEMETRY_TOPIC[]     = "users/%{userid}/devices/%{deviceid}/%{version}/telemetry/#";
const char ACK_TOPIC[]           = "users/%{userid}/devices/%{deviceid}/%{version}/ack/#";
const char HEARTBEAT_TOPIC[]     = "users/%{userid}/devices/%{deviceid}/%{version}/heartbeat";
const char AP_HOTSPOT_NAME[]     = DEVICE_TYPE_STR "_Setup";
const char AP_HOTSPOT_PASSWORD[] = ""; // Open network for easier provisioning
const char SERVICE_UUID[]        = "12345678-1234-5678-1234-56789abcdef0";
const char CHAR_UUID[]           = "abcdef01-1234-5678-1234-56789abcdef0";
const int  BUTTON_PIN            = 0;
const int  READING_INTERVAL      = 10000;      // 10 seconds
const long HEARTBEAT_INTERVAL_MS = 60L * 1000; // liveness ping cadence (must be < digest's last-seen TTL)
const long JWT_REFRESH_POLICY    = 60 * 7.5;
const bool FORCE_WPA3            = false;
#ifdef ENV_PROD
const bool PROVISION_ON_ERROR = false;
#else
const bool PROVISION_ON_ERROR = true;
#endif
const long WIFI_TIMEOUT = 1000 * 60 * 60; // 60 min

// --- Clock validity -------------------------------------------------------------------
// The ESP boots its RTC at epoch 0, so any time below this means NTP has never answered.
// Nothing may judge a token's expiry (or trust a TLS notBefore/notAfter) under that clock:
// doing so declares a healthy credential dead and used to wipe the device's provisioning.
const time_t MIN_VALID_EPOCH = 24 * 3600;

// --- Network resilience ---------------------------------------------------------------
// A router reboot (a nightly event on many home networks) takes the LAN down for seconds
// and the WAN for minutes. Every network dependency below therefore retries with backoff
// and NEVER clears credentials or reboots — a transient outage must not cost provisioning.
const unsigned long NTP_SYNC_TIMEOUT_MS    = 60UL * 1000;      // bounded first-sync wait at boot
const unsigned long NTP_RETRY_INTERVAL_MS  = 5UL * 60 * 1000;  // background re-sync cadence
const unsigned long WIFI_RETRY_INTERVAL_MS = 20UL * 1000;      // explicit re-associate nudge
const unsigned long MQTT_BACKOFF_MIN_MS    = 5UL * 1000;       // first retry delay after a drop
const unsigned long MQTT_BACKOFF_MAX_MS    = 5UL * 60 * 1000;  // backoff ceiling
const unsigned long CONFIG_RETRY_MIN_MS    = 10UL * 1000;      // served-config fetch retry floor
const unsigned long CONFIG_RETRY_MAX_MS    = 10UL * 60 * 1000; // served-config fetch ceiling
