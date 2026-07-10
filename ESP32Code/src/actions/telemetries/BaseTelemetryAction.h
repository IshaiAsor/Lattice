
#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include <functional>
#include "actions/ActionPinsSetup.h"
#include "actions/DeviceAction.h"
#include "config/Log.h"

// Read surface of DeviceAction — sensors that produce a reading, cyclically (interval) and/or
// on demand (the `read` verb). Leaf classes override only executeTelemetryAction().
class BaseTelemetryAction : public DeviceAction
{
  protected:
    virtual String executeTelemetryAction() = 0;

  public:
    int           actionReadInterval;
    unsigned long lastReadTime  = 0;
    bool          healthy       = true;
    String        errorMessage  = "";
    long          lastErrorTime = 0;

    BaseTelemetryAction(String name, int readInterval, std::vector<ActionPinsSetup> pinsSetup)
        : DeviceAction(name, pinsSetup)
    {
        actionReadInterval = readInterval;
    }

    bool hasReadSurface() const override { return true; }

    // Cyclic read on the configured interval. Publishes the raw scalar on success (backward
    // compatible) or a fault envelope on a failed read (digest records error duration).
    void tick(unsigned long currentTime, TelemetryCallback callback) override
    {
        if (!_behaviorInterval) // cyclic reads gated on the `interval` behavior (on-demand-only sensors)
            return;
        if (currentTime - lastReadTime >= (unsigned long)actionReadInterval)
        {
            lastReadTime = currentTime;
            LOG_D("Sensor", "reading %s", actionName.c_str());
            String msg = executeTelemetryAction();
            if (msg.length() > 0)
            {
                callback(actionName.c_str(), msg.c_str());
                healthy       = true;
                errorMessage  = "";
                lastErrorTime = 0;
            }
            else
            {
                healthy       = false;
                errorMessage  = "Unable to read data from sensor : " + actionName;
                lastErrorTime = currentTime;
                LOG_W("Sensor", "read failed: %s", actionName.c_str());
                // Fault reading on the same telemetry topic so the backend can record error
                // duration (skips state/threshold — digest branches on the "error" key).
                String fault = "{\"error\":\"read_failed\",\"action\":\"" + actionName + "\"}";
                callback(actionName.c_str(), fault.c_str());
            }
        }
    }

    // On-demand read (the `read` verb). Samples immediately, bypassing the interval, and
    // publishes an envelope {"value":..,"commandId":..} so the backend correlates the answer
    // to the request. A failed read still answers, with the same fault envelope.
    void readNow(TelemetryCallback callback, const String& commandId) override
    {
        LOG_D("Sensor", "on-demand read %s (commandId=%s)", actionName.c_str(), commandId.c_str());
        String msg = executeTelemetryAction();
        String payload;
        if (msg.length() > 0)
        {
            payload       = "{\"value\":\"" + msg + "\",\"commandId\":\"" + commandId + "\"}";
            healthy       = true;
            errorMessage  = "";
            lastErrorTime = 0;
        }
        else
        {
            healthy      = false;
            errorMessage = "Unable to read data from sensor : " + actionName;
            payload =
                "{\"error\":\"read_failed\",\"action\":\"" + actionName + "\",\"commandId\":\"" + commandId + "\"}";
            LOG_W("Sensor", "on-demand read failed: %s", actionName.c_str());
        }
        callback(actionName.c_str(), payload.c_str());
    }
};
