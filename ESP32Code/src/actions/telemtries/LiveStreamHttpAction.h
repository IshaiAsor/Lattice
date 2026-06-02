#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <vector>
#include "actions/telemtries/BaseTelemtryAction.h"
#include "actions/ActionPinsSetup.h"
#include "esp_camera.h"
#include "services/HttpFrameService.h"

// Defined in SmartHome.cpp
extern HttpFrameService httpFrameService;

class LiveStreamHttpAction : public BaseTelemetryAction
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
            config.fb_count     = 3;
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
        if (s)
        {
            uint16_t pid = s->id.PID;
            Serial.printf("[Camera] Sensor PID: 0x%04X\n", pid);

            if (pid == 0x3660)  // OV3660
            {
                s->set_framesize(s,  FRAMESIZE_SVGA);  // 800×600
                s->set_quality(s,    8);
                s->set_sharpness(s,  2);
                s->set_contrast(s,   1);
                s->set_saturation(s, 0);
                Serial.println("[Camera] OV3660: SVGA q8 (HTTP stream)");
            }
            else if (pid == 0x5640)  // OV5640
            {
                s->set_framesize(s,  FRAMESIZE_XGA);   // 1024×768
                s->set_quality(s,    6);
                s->set_sharpness(s,  2);
                s->set_contrast(s,   1);
                s->set_saturation(s, 1);
                Serial.println("[Camera] OV5640: XGA q6 (HTTP stream)");
            }
            else
            {
                Serial.printf("[Camera] Unknown sensor 0x%04X — generic settings\n", pid);
                s->set_framesize(s, FRAMESIZE_SVGA);
                s->set_sharpness(s, 2);
                s->set_contrast(s,  1);
            }

            for (int i = 0; i < 5; i++)
            {
                camera_fb_t *warmup = esp_camera_fb_get();
                if (warmup) esp_camera_fb_return(warmup);
            }
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

        Serial.printf("[Camera] Captured %u bytes JPEG -> HTTP /api/camera/frame?type=stream\n",
                      (unsigned)fb->len);
        httpFrameService.sendFrame(fb->buf, fb->len, false);
        esp_camera_fb_return(fb);

        return "";
    }

public:
    LiveStreamHttpAction(String name, std::vector<ActionPinsSetup> pins, int readInterval)
        : BaseTelemetryAction(name, readInterval, pins)
    {
        initCamera();
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
