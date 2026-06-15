#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <vector>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/ActionPinsSetup.h"
#include "esp_camera.h"
#include "services/CameraService.h"
#include "services/HttpFrameService.h"

// Defined in SmartHome.cpp
extern HttpFrameService httpFrameService;

class TakePictureHttpAction : public BaseTelemetryAction
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
        return { "camera_http_capture", "Camera (Snapshot HTTP)", "TakePictureHttpAction", "telemetry",
                 "camera_http_capture", googleActionType(), supportedTraits(), 1000, blueprint() };
    }

protected:
    String executeTelemetryAction() override
    {
        if (!CameraService::isReady())
        {
            Serial.println("[Camera] Not ready — skipping capture");
            return "";
        }

        if (!httpFrameService.isReady())
        {
            Serial.println("[HTTP Cam] Service not ready — skipping capture");
            return "";
        }

        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb)
        {
            Serial.println("[Camera] Frame capture failed");
            return "";
        }

        Serial.printf("[Camera] Captured %u bytes JPEG -> HTTP /api/camera/frame?type=capture\n",
                      (unsigned)fb->len);
        httpFrameService.sendFrame(fb->buf, fb->len, true);
        esp_camera_fb_return(fb);

        return "";
    }

public:
    TakePictureHttpAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        CameraService::init();
    }

    void initPins() override {}

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
