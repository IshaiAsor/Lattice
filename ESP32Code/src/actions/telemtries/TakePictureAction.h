#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <vector>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/ActionPinsSetup.h"
#include "esp_camera.h"
#include "services/LiveStreamService.h"
#ifdef MOCK_CAMERA
#include "mocks/mock_camera_frame.h"
#endif

// Defined in SmartHome.cpp
extern LiveStreamService wsCaptureService;

class TakePictureAction : public BaseTelemetryAction
{
public:
    static const PinSlotDef* blueprint() {
        static const PinSlotDef slots[] = { { nullptr } };
        return slots;
    }

    static const GoogleTraitDef* supportedTraits() {
        static const GoogleTraitDef traits[] = {
            { "action.devices.traits.CameraStream", "CameraStream" },
            { nullptr }
        };
        return traits;
    }

private:
    bool _cameraReady = false;

    void initCamera()
    {
#ifdef MOCK_CAMERA
        _cameraReady = true;
        Serial.println("[Camera] MOCK_CAMERA: skipping hardware init (TakePicture)");
        return;
#endif
        camera_config_t config;
        config.ledc_channel = LEDC_CHANNEL_0;
        config.ledc_timer   = LEDC_TIMER_0;
        config.pin_d0       = Y2_GPIO_NUM;
        config.pin_d1       = Y3_GPIO_NUM;
        config.pin_d2       = Y4_GPIO_NUM;
        config.pin_d3       = Y5_GPIO_NUM;
        config.pin_d4       = Y6_GPIO_NUM;
        config.pin_d5       = Y7_GPIO_NUM;
        config.pin_d6       = Y8_GPIO_NUM;
        config.pin_d7       = Y9_GPIO_NUM;
        config.pin_xclk     = XCLK_GPIO_NUM;
        config.pin_pclk     = PCLK_GPIO_NUM;
        config.pin_vsync    = VSYNC_GPIO_NUM;
        config.pin_href     = HREF_GPIO_NUM;
        config.pin_sccb_sda = SIOD_GPIO_NUM;
        config.pin_sccb_scl = SIOC_GPIO_NUM;
        config.pin_pwdn     = PWDN_GPIO_NUM;
        config.pin_reset    = RESET_GPIO_NUM;
        config.xclk_freq_hz = 20000000;
        config.pixel_format = PIXFORMAT_JPEG;

        if (psramFound())
        {
            config.frame_size   = FRAMESIZE_SVGA;  // overridden per-sensor after init
            config.jpeg_quality = 10;
            config.fb_count     = 2;
        }
        else
        {
            config.frame_size   = FRAMESIZE_QQVGA;
            config.jpeg_quality = 15;
            config.fb_count     = 1;
        }

        esp_err_t err = esp_camera_init(&config);
        if (err != ESP_OK)
        {
            Serial.printf("[Camera] Init failed: 0x%x\n", err);
            _cameraReady = false;
            return;
        }

        _cameraReady = true;
        sensor_t *s = esp_camera_sensor_get();
        if (!s) return;

        uint16_t pid = s->id.PID;
        Serial.printf("[Camera] Sensor PID: 0x%04X\n", pid);

        int warmupFrames = 1;
        if (pid == 0x3660)  // OV3660 — 3MP, UXGA max
        {
            s->set_framesize(s,     FRAMESIZE_UXGA);  // 1600×1200
            s->set_quality(s,        3);
            s->set_sharpness(s,     2);
            s->set_contrast(s,      1);
            s->set_saturation(s,    0);
            warmupFrames = 2;
            Serial.println("[Camera] OV3660 configured: UXGA q3");
        }
        else if (pid == 0x5640)  // OV5640 — 5MP, UXGA reliable
        {
            s->set_framesize(s,     FRAMESIZE_UXGA);  // 1600×1200
            s->set_quality(s,        2);
            s->set_sharpness(s,     2);
            s->set_contrast(s,      1);
            s->set_saturation(s,    1);
            warmupFrames = 3;
            Serial.println("[Camera] OV5640 configured: UXGA q2");
        }
        else
        {
            Serial.printf("[Camera] Unknown sensor 0x%04X — generic settings\n", pid);
            s->set_sharpness(s, 2);
            s->set_contrast(s, 1);
        }

        for (int i = 0; i < warmupFrames; i++)
        {
            camera_fb_t *warmup = esp_camera_fb_get();
            if (warmup) esp_camera_fb_return(warmup);
        }
    }

protected:
    String executeTelemetryAction() override
    {
        if (!_cameraReady)
        {
            Serial.println("[Camera] Not ready — skipping capture");
            return "";
        }

        if (!wsCaptureService.isConnected())
        {
            Serial.println("[Capture] Not connected — skipping frame");
            return "";
        }

#ifdef MOCK_CAMERA
        wsCaptureService.sendFrame(MOCK_FRAME_BYTES, MOCK_FRAME_LEN);
        Serial.printf("[Camera] Mock frame sent (%u bytes) via /ws/capture\n", (unsigned)MOCK_FRAME_LEN);
        return "";
#else
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
#endif
    }

public:
    TakePictureAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        initCamera();
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
