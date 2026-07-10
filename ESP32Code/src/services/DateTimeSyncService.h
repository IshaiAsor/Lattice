#pragma once
#include <Arduino.h>
#include <time.h>
#include "config/Log.h"

class DateTimeSyncService
{
  public:
    // --- Sync Time via NTP ---
    void syncTime()
    {
        LOG_I("Time", "syncing time via NTP");
        configTime(2 * 3600, 0, "pool.ntp.org", "time.nist.gov");

        time_t now = time(nullptr);
        while (now < 24 * 3600)
        {
            delay(500);
            Serial.print(".");
            now = time(nullptr);
        }
        Serial.println();
        LOG_I("Time", "time synced");
    }
};