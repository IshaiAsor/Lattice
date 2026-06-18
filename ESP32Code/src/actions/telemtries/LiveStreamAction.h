#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <vector>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/ActionPinsSetup.h"
#include "esp_camera.h"
#include "services/CameraService.h"
#include "services/LiveStreamService.h"
#include "actions/manifest/CapabilityRegistry.h"

// Defined in SmartHome.cpp
extern LiveStreamService liveStreamService;

class LiveStreamAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint()        { return CapabilityRegistry::camera().pins; }
    static const char* googleActionType()       { return CapabilityRegistry::camera().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::camera().traits; }
    static CapabilityDescriptor capability()    { return CapabilityRegistry::camera(); }
    static const char* implType()               { return capability().implType; }

protected:
    String executeTelemetryAction() override
    {
        if (!CameraService::isReady())
        {
            Serial.println("[Camera] Not ready — skipping capture");
            return "";
        }

        if (!liveStreamService.isConnected())
        {
            Serial.println("[Stream] Not connected — skipping frame");
            return "";
        }

        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb)
        {
            Serial.println("[Camera] Frame capture failed");
            return "";
        }

        // Drop frames that are unusually large — an AEC spike can produce 2× normal
        // SVGA JPEG size, which stresses the TCP send buffer and triggers disconnects.
        if (fb->len > 60000)
        {
            Serial.printf("[Camera] Frame too large (%u bytes) — dropping\n", (unsigned)fb->len);
            esp_camera_fb_return(fb);
            return "";
        }

        Serial.printf("[Camera] Captured %u bytes JPEG -> sending via WS\n", (unsigned)fb->len);
        liveStreamService.sendFrame(fb->buf, fb->len);
        esp_camera_fb_return(fb);

        return "";  // no MQTT publish — WS handles delivery
    }

public:
    LiveStreamAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        CameraService::init();
    }

    void initPins() override {}  // Camera driver owns all GPIO

    // Override to bypass BaseTelemetryAction's "empty return = error" logic.
    // WS delivery never goes through the MQTT callback so returning "" is normal.
    void execute(unsigned long currentTime,
                 std::function<void(const char *, const char *)> /*callback*/) override
    {
        if (currentTime - lastReadTime >= actionReadInterval)
        {
            lastReadTime = currentTime;
            executeTelemetryAction();
        }
    }
};

#endif // HAS_CAMERA
