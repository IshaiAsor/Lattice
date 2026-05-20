#pragma once
#include <Arduino.h>
#include <time.h>

class DateTimeSyncService{
public:
  // --- Sync Time via NTP ---
  void syncTime()
{
  Serial.print("Syncing time");
  configTime(2 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  
  time_t now = time(nullptr);
  while (now < 24 * 3600)
  {
    delay(500);
    Serial.print(".");
    now = time(nullptr);
  }
  Serial.println("\nTime synced successfully!");
}
};