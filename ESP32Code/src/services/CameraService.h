#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include "esp_camera.h"
#include "services/Ov5640AutoFocus.h"
#include "config/Log.h"

// Shared singleton that initializes the ESP32 camera driver exactly once.
// All camera action classes call CameraService::init() and then use
// esp_camera_fb_get() / esp_camera_fb_return() directly — those are thread-safe
// in ESP-IDF and don't need additional wrapping.
class CameraService
{
  public:
    static bool init()
    {
        if (_ready)
            return true;

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
            config.frame_size   = FRAMESIZE_SVGA;
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
            LOG_E("Camera", "init failed: 0x%x", err);
            return false;
        }

        sensor_t* s = esp_camera_sensor_get();
        if (s)
        {
            uint16_t pid = s->id.PID;
            LOG_D("Camera", "sensor PID: 0x%04X", pid);
            if (pid == 0x3660)
            { // OV3660
                s->set_framesize(s, FRAMESIZE_SVGA);
                s->set_quality(s, 8);
                s->set_sharpness(s, 2);
                s->set_contrast(s, 1);
                s->set_saturation(s, 0);
                LOG_I("Camera", "OV3660: SVGA q8");
            }
            else if (pid == 0x5640)
            { // OV5640
                s->set_framesize(s, FRAMESIZE_XGA);
                s->set_quality(s, 6);
                s->set_sharpness(s, 2);
                s->set_contrast(s, 1);
                s->set_saturation(s, 1);
                LOG_I("Camera", "OV5640: XGA q6");

                if (Ov5640AutoFocus::init(s))
                {
                    LOG_I("Camera", "OV5640: continuous autofocus enabled");
                }
                else
                {
                    LOG_W("Camera", "OV5640: autofocus unavailable (no VCM lens?)");
                }
            }
            else
            {
                LOG_W("Camera", "unknown sensor 0x%04X — generic settings", pid);
                s->set_framesize(s, FRAMESIZE_SVGA);
                s->set_sharpness(s, 2);
                s->set_contrast(s, 1);
            }
        }

        // Let AEC/AWB settle before the first real capture
        for (int i = 0; i < 5; i++)
        {
            camera_fb_t* warmup = esp_camera_fb_get();
            if (warmup)
                esp_camera_fb_return(warmup);
        }

        _ready = true;
        LOG_I("Camera", "ready");
        return true;
    }

    static bool isReady() { return _ready; }

    // Applies a user-configured resolution override on top of init()'s PSRAM/sensor-PID
    // defaults. Called once by CameraAction after init() if the instance has a configured
    // camera_resolution; a no-op if the sensor isn't ready.
    static void applyResolution(framesize_t fs)
    {
        if (!_ready)
            return;
        sensor_t* s = esp_camera_sensor_get();
        if (s)
            s->set_framesize(s, fs);
    }

    // Maps the backend's camera_resolution string (device-config JSON) to a framesize_t.
    // Unrecognized/empty values return false and leave out untouched (caller keeps init()'s default).
    static bool resolutionFromString(const String& name, framesize_t& out)
    {
        if (name == "QQVGA")
        {
            out = FRAMESIZE_QQVGA;
            return true;
        }
        if (name == "QVGA")
        {
            out = FRAMESIZE_QVGA;
            return true;
        }
        if (name == "VGA")
        {
            out = FRAMESIZE_VGA;
            return true;
        }
        if (name == "SVGA")
        {
            out = FRAMESIZE_SVGA;
            return true;
        }
        if (name == "XGA")
        {
            out = FRAMESIZE_XGA;
            return true;
        }
        if (name == "HD")
        {
            out = FRAMESIZE_HD;
            return true;
        }
        if (name == "SXGA")
        {
            out = FRAMESIZE_SXGA;
            return true;
        }
        if (name == "UXGA")
        {
            out = FRAMESIZE_UXGA;
            return true;
        }
        if (name == "FHD")
        {
            out = FRAMESIZE_FHD;
            return true;
        }
        if (name == "QXGA")
        {
            out = FRAMESIZE_QXGA;
            return true;
        }
        if (name == "QHD")
        {
            out = FRAMESIZE_QHD;
            return true;
        }
        if (name == "WQXGA")
        {
            out = FRAMESIZE_WQXGA;
            return true;
        }
        if (name == "QSXGA")
        {
            out = FRAMESIZE_QSXGA;
            return true;
        }
        return false;
    }

  private:
    static bool _ready;
};

inline bool CameraService::_ready = false;

#endif // HAS_CAMERA
