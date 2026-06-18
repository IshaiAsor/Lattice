#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <vector>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/ActionPinsSetup.h"
#include "esp_camera.h"
#include "services/CameraService.h"
#include "services/HttpFrameService.h"
#include "actions/manifest/CapabilityRegistry.h"

// Defined in SmartHome.cpp
extern HttpFrameService httpFrameService;

class LiveStreamHttpAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint()        { return CapabilityRegistry::cameraHttpStream().pins; }
    static const char* googleActionType()       { return CapabilityRegistry::cameraHttpStream().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::cameraHttpStream().traits; }
    static CapabilityDescriptor capability()    { return CapabilityRegistry::cameraHttpStream(); }
    static const char* implType()               { return capability().implType; }

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
            Serial.println("[HTTP Cam] Service not ready — skipping frame");
            return "";
        }

        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb)
        {
            Serial.println("[Camera] Frame capture failed");
            return "";
        }

        Serial.printf("[Camera] Captured %u bytes JPEG -> HTTP /api/camera/frame?action=%s\n",
                      (unsigned)fb->len, actionName.c_str());
        httpFrameService.sendFrame(fb->buf, fb->len, actionName);
        esp_camera_fb_return(fb);

        return "";
    }

public:
    LiveStreamHttpAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
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
