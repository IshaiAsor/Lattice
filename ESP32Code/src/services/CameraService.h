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

        _config = pinConfig();
        if (psramFound())
        {
            _config.frame_size   = FRAMESIZE_SVGA;
            _config.jpeg_quality = 10;
            _config.fb_count     = 3;
        }
        else
        {
            _config.frame_size   = FRAMESIZE_QQVGA;
            _config.jpeg_quality = 15;
            _config.fb_count     = 1;
        }

        esp_err_t err = esp_camera_init(&_config);
        if (err != ESP_OK)
        {
            LOG_E("Camera", "init failed: 0x%x", err);
            return false;
        }
        _ready = true;

        sensor_t* s = esp_camera_sensor_get();
        _sensorPid  = s ? s->id.PID : 0;
        LOG_D("Camera", "sensor PID: 0x%04X", _sensorPid);

        // Per-sensor target resolutions may exceed the PSRAM-branch's SVGA init size — routed
        // through applyResolution() so it grows the driver's capture buffer via a real reinit
        // instead of just poking sensor registers (see applyResolution() for why that matters).
        if (_sensorPid == 0x3660) // OV3660
            applyResolution(FRAMESIZE_SVGA);
        else if (_sensorPid == 0x5640) // OV5640
            applyResolution(FRAMESIZE_XGA);

        applyTuning();

        if (_sensorPid == 0x5640)
        {
            sensor_t* s2 = esp_camera_sensor_get();
            if (s2 && Ov5640AutoFocus::init(s2))
                LOG_I("Camera", "OV5640: continuous autofocus enabled");
            else
                LOG_W("Camera", "OV5640: autofocus unavailable (no VCM lens?)");
        }

        // Let AEC/AWB settle before the first real capture
        for (int i = 0; i < 5; i++)
        {
            camera_fb_t* warmup = esp_camera_fb_get();
            if (warmup)
                esp_camera_fb_return(warmup);
        }

        LOG_I("Camera", "ready");
        return true;
    }

    static bool isReady() { return _ready; }

    // Applies a user-configured resolution override on top of init()'s PSRAM/sensor-PID
    // defaults. esp_camera_init() sizes its DMA/JPEG capture buffer once, from the frame_size
    // it was given — sensor_t::set_framesize() alone only rewrites sensor registers and never
    // grows that buffer. Requesting more pixels than the driver was initialized for silently
    // overflows the fixed buffer and esp_camera_fb_get() starts failing, so growing past the
    // current capacity goes through a real deinit/reinit instead.
    static void applyResolution(framesize_t fs)
    {
        if (!_ready)
            return;

        if (pixelCount(fs) > pixelCount(_config.frame_size))
        {
            LOG_D("Camera", "growing capture buffer %ux%u -> %ux%u", resolution[_config.frame_size].width,
                  resolution[_config.frame_size].height, resolution[fs].width, resolution[fs].height);

            camera_config_t grown = _config;
            grown.frame_size      = fs;

            esp_camera_deinit();
            esp_err_t err = esp_camera_init(&grown);
            if (err != ESP_OK)
            {
                LOG_E("Camera", "reinit at %ux%u failed: 0x%x — reverting", resolution[fs].width, resolution[fs].height,
                      err);
                esp_camera_init(&_config); // best-effort restore of the known-good config
                applyTuning();
                return;
            }
            _config = grown;
            applyTuning(); // deinit/reinit resets sensor registers, incl. quality/sharpness
        }

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
    static bool            _ready;
    static camera_config_t _config;
    static uint16_t        _sensorPid;

    static uint32_t pixelCount(framesize_t fs) { return (uint32_t)resolution[fs].width * resolution[fs].height; }

    static camera_config_t pinConfig()
    {
        camera_config_t config = {};
        config.ledc_channel    = LEDC_CHANNEL_0;
        config.ledc_timer      = LEDC_TIMER_0;
        config.pin_d0          = Y2_GPIO_NUM;
        config.pin_d1          = Y3_GPIO_NUM;
        config.pin_d2          = Y4_GPIO_NUM;
        config.pin_d3          = Y5_GPIO_NUM;
        config.pin_d4          = Y6_GPIO_NUM;
        config.pin_d5          = Y7_GPIO_NUM;
        config.pin_d6          = Y8_GPIO_NUM;
        config.pin_d7          = Y9_GPIO_NUM;
        config.pin_xclk        = XCLK_GPIO_NUM;
        config.pin_pclk        = PCLK_GPIO_NUM;
        config.pin_vsync       = VSYNC_GPIO_NUM;
        config.pin_href        = HREF_GPIO_NUM;
        config.pin_sccb_sda    = SIOD_GPIO_NUM;
        config.pin_sccb_scl    = SIOC_GPIO_NUM;
        config.pin_pwdn        = PWDN_GPIO_NUM;
        config.pin_reset       = RESET_GPIO_NUM;
        // Must be exactly 16MHz on ESP32-S3/S2: esp32-camera only enables its PSRAM/EDMA DMA
        // path (cam_hal's psram_mode) at this exact frequency. Any other value — including the
        // previous 20MHz — falls back to a small fixed internal-DRAM DMA ring (32KB by default,
        // CONFIG_CAMERA_DMA_BUFFER_SIZE_MAX), which is too small for SVGA+ JPEG frames and
        // produces both corrupted frames and esp_camera_fb_get() failures at higher resolutions.
        config.xclk_freq_hz = 16000000;
        config.pixel_format = PIXFORMAT_JPEG;
        return config;
    }

    static void applyTuning()
    {
        sensor_t* s = esp_camera_sensor_get();
        if (!s)
            return;
        if (_sensorPid == 0x3660)
        { // OV3660
            s->set_quality(s, 8);
            s->set_sharpness(s, 2);
            s->set_contrast(s, 1);
            s->set_saturation(s, 0);
            LOG_I("Camera", "OV3660: SVGA q8");
        }
        else if (_sensorPid == 0x5640)
        { // OV5640
            s->set_quality(s, 6);
            s->set_sharpness(s, 2);
            s->set_contrast(s, 1);
            s->set_saturation(s, 1);
            LOG_I("Camera", "OV5640: XGA q6");
        }
        else
        {
            LOG_W("Camera", "unknown sensor 0x%04X — generic settings", _sensorPid);
            s->set_sharpness(s, 2);
            s->set_contrast(s, 1);
        }
    }
};

inline bool            CameraService::_ready     = false;
inline camera_config_t CameraService::_config    = {};
inline uint16_t        CameraService::_sensorPid = 0;

#endif // HAS_CAMERA
