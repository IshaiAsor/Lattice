#pragma once
#include <Arduino.h>
#include <time.h>
#include "config/settings.h"
#include "config/Log.h"

// NTP sync with a *bounded* wait. A device that boots while its router is still bringing the
// WAN up (e.g. after a nightly router restart) must not hang here: the first sync gives up
// after NTP_SYNC_TIMEOUT_MS, boot continues with an unsynced clock, and loop() re-arms SNTP
// in the background until the clock is good. Callers that need a trustworthy clock — JWT
// expiry checks, TLS certificate validity — gate on isSynced() rather than assuming.
class DateTimeSyncService
{
  private:
    bool          _configured  = false;
    unsigned long _nextRetryMs = 0;

    void armSntp()
    {
        // TZ offset is UTC+2 with no DST rule (unchanged from the original behaviour).
        configTime(2 * 3600, 0, "pool.ntp.org", "time.nist.gov");
        _configured = true;
    }

  public:
    bool isSynced() { return time(nullptr) >= MIN_VALID_EPOCH; }

    // Blocks up to timeoutMs waiting for the first valid time. Returns whether the clock is
    // now trustworthy; a false return is not fatal — the caller proceeds and loop() retries.
    bool syncTime(unsigned long timeoutMs = NTP_SYNC_TIMEOUT_MS)
    {
        LOG_I("Time", "syncing time via NTP");
        armSntp();

        unsigned long start = millis();
        while (!isSynced() && (millis() - start) < timeoutMs)
        {
            delay(500);
            Serial.print('.');
        }
        Serial.println();

        if (isSynced())
        {
            LOG_I("Time", "time synced");
            return true;
        }

        LOG_W("Time", "NTP did not answer within %lu ms — continuing with an unsynced clock", timeoutMs);
        _nextRetryMs = millis() + NTP_RETRY_INTERVAL_MS;
        return false;
    }

    // Non-blocking background retry; call once per loop() tick. No-op once the clock is good.
    void loop()
    {
        if (isSynced())
            return;

        unsigned long now = millis();
        if (_configured && (long)(now - _nextRetryMs) < 0) // rollover-safe compare
            return;

        _nextRetryMs = now + NTP_RETRY_INTERVAL_MS;
        LOG_D("Time", "clock still unsynced — re-arming NTP");
        armSntp();
    }
};
