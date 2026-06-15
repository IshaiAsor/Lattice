#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <vector>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/ActionPinsSetup.h"
#include "esp_camera.h"
#include "services/CameraService.h"
#include "services/LiveStreamService.h"

// Defined in SmartHome.cpp
extern LiveStreamService wsCaptureService;

class TakePictureAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint() {
        static const PinSlotDef slots[] = { { nullptr } };
        return slots;
    }

    static const char* googleActionType() { return "action.devices.types.CAMERA"; }

    static const GoogleTraitDef* supportedTraits() {
        static const GoogleTraitDef traits[] = {
            { "action.devices.traits.CameraStream", "CameraStream" },
            { nullptr }
        };
        return traits;
    }

    static CapabilityDescriptor capability() {
        return { "camera_ws_capture", "Camera (Snapshot WS)", "TakePictureAction", "telemetry",
                 "camera_ws_capture", googleActionType(), supportedTraits(), 1000, blueprint() };
    }

protected:
    String executeTelemetryAction() override
    {
        if (!CameraService::isReady())
        {
            Serial.println("[Camera] Not ready — skipping capture");
            return "";
        }

        if (!wsCaptureService.isConnected())
        {
            Serial.println("[Capture] Not connected — skipping frame");
            return "";
        }

        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb)
        {
            Serial.println("[Camera] Frame capture failed");
            return "";
        }

        Serial.printf("[Camera] Captured %u bytes JPEG -> sending via /ws/capture\n", (unsigned)fb->len);
        wsCaptureService.sendFrame(fb->buf, fb->len);
        esp_camera_fb_return(fb);

        return "";  // delivery via WebSocket, not MQTT
    }

public:
    TakePictureAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        CameraService::init();
    }

    void initPins() override {}  // Camera driver owns all GPIO

    // Bypass BaseTelemetryAction's MQTT callback — WS delivery never returns a payload.
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
