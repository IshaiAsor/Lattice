#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <vector>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/ActionPinsSetup.h"
#include "esp_camera.h"
#include "services/CameraService.h"
#include "services/LiveStreamService.h"
#include "services/HttpFrameService.h"
#include "actions/manifest/CapabilityRegistry.h"

// Defined in main.cpp. At most one CameraAction ever exists per device (see the
// one-camera-per-device rule enforced by DeviceCapability provisioning), so a single shared
// WS connection covers it; the HTTP frame service already multiplexes by actionName and is
// shared with every other telemetry action.
extern LiveStreamService cameraWsService;
extern HttpFrameService  httpFrameService;

// Unified camera action — replaces the old TakePictureAction/TakePictureHttpAction/
// LiveStreamAction/LiveStreamHttpAction split. Captures periodically on its configured
// interval (BaseTelemetryAction's normal timer) and on-demand via triggerCapture() (called
// by DynamicDeviceActionsService when a take_picture command arrives), delivering over
// whichever transport (WS or HTTP) this instance is configured for.
class CameraAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint()        { return CapabilityRegistry::camera().pins; }
    static const char* googleActionType()       { return CapabilityRegistry::camera().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::camera().traits; }
    static CapabilityDescriptor capability()    { return CapabilityRegistry::camera(); }
    static const char* implType()               { return capability().implType; }

private:
    bool _useWs = false;

    void captureAndSend(const String& commandId)
    {
        if (!CameraService::isReady())
        {
            Serial.println("[Camera] Not ready — skipping capture");
            return;
        }

        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb)
        {
            Serial.println("[Camera] Frame capture failed");
            return;
        }

        const char *via = commandId.length() ? " (on-demand)" : "";
        if (_useWs)
        {
            if (!cameraWsService.isConnected())
                Serial.println("[Camera] WS not connected — skipping frame");
            else
            {
                Serial.printf("[Camera] Captured %u bytes JPEG -> WS%s\n", (unsigned)fb->len, via);
                cameraWsService.sendFrame(fb->buf, fb->len, commandId);
            }
        }
        else
        {
            if (!httpFrameService.isReady())
                Serial.println("[Camera] HTTP frame service not ready — skipping frame");
            else
            {
                Serial.printf("[Camera] Captured %u bytes JPEG -> HTTP /api/camera/frame?action=%s%s\n",
                              (unsigned)fb->len, actionName.c_str(), via);
                httpFrameService.sendFrame(fb->buf, fb->len, actionName, commandId);
            }
        }

        esp_camera_fb_return(fb);
    }

protected:
    String executeTelemetryAction() override
    {
        captureAndSend("");
        return "";  // delivery is out-of-band (WS/HTTP), not the MQTT telemetry return path
    }

public:
    CameraAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        CameraService::init();
    }

    // Applies per-instance config from the backend. Called once right after construction —
    // separate from the constructor because DynamicDeviceActionsService's generic
    // tryCreateTel<T> factory only threads (name, pins, interval) through to every telemetry
    // action's constructor uniformly; these two extra fields are camera-only.
    void configure(const String& resolution, const String& transport)
    {
        _useWs = (transport == "ws");
        framesize_t fs;
        if (CameraService::resolutionFromString(resolution, fs)) CameraService::applyResolution(fs);
    }

    void initPins() override {}  // Camera driver owns all GPIO

    // Bypass BaseTelemetryAction's MQTT callback — frame delivery is WS/HTTP, not MQTT.
    void execute(unsigned long currentTime,
                 std::function<void(const char *, const char *)> /*callback*/) override
    {
        if (currentTime - lastReadTime >= actionReadInterval)
        {
            lastReadTime = currentTime;
            executeTelemetryAction();
        }
    }

    // Called by DynamicDeviceActionsService when a take_picture command arrives — captures
    // immediately, bypassing the interval timer, and tags the frame with commandId so the
    // backend can correlate it back to the in-flight pipeline request.
    void triggerCapture(const String& commandId)
    {
        Serial.println("[Camera] On-demand capture requested (commandId=" + commandId + ")");
        captureAndSend(commandId);
    }
};

#endif // HAS_CAMERA
