#pragma once
#if defined(HAS_CAMERA) && defined(CAMERA_SELFTEST)

#include <Arduino.h>
#include "esp_camera.h"
#include "img_converters.h"
#include "config/Log.h"

// Pre-network camera sweep. Runs at the very top of setup(), before WiFi, BLE, TLS or MQTT
// exist, so anything that fails here is the board or the pin map — not contention with the
// network stack. It exists because the Arduino framework links a *prebuilt*
// libesp32-camera.a with every diagnostic string compiled out (verified: "FB-OVF",
// "Failed to get the frame on time", "DMA Channel=" are all absent from the archive), so the
// driver physically cannot report why a capture failed. Sweeping the inputs and watching which
// combinations produce bytes is the only channel left.
//
// Compiled away entirely without -D CAMERA_SELFTEST.
namespace CameraSelfTest
{

inline camera_config_t config(int xclk, framesize_t fs, int fbCount)
{
    camera_config_t c = {};
    c.ledc_channel    = LEDC_CHANNEL_0;
    c.ledc_timer      = LEDC_TIMER_0;
    c.pin_d0          = Y2_GPIO_NUM;
    c.pin_d1          = Y3_GPIO_NUM;
    c.pin_d2          = Y4_GPIO_NUM;
    c.pin_d3          = Y5_GPIO_NUM;
    c.pin_d4          = Y6_GPIO_NUM;
    c.pin_d5          = Y7_GPIO_NUM;
    c.pin_d6          = Y8_GPIO_NUM;
    c.pin_d7          = Y9_GPIO_NUM;
    c.pin_xclk        = XCLK_GPIO_NUM;
    c.pin_pclk        = PCLK_GPIO_NUM;
    c.pin_vsync       = VSYNC_GPIO_NUM;
    c.pin_href        = HREF_GPIO_NUM;
    c.pin_sccb_sda    = SIOD_GPIO_NUM;
    c.pin_sccb_scl    = SIOC_GPIO_NUM;
    c.pin_pwdn        = PWDN_GPIO_NUM;
    c.pin_reset       = RESET_GPIO_NUM;
    c.xclk_freq_hz    = xclk;
    c.pixel_format    = PIXFORMAT_JPEG;
    c.frame_size      = fs;
    c.jpeg_quality    = 12;
    c.fb_count        = fbCount;
    c.fb_location     = CAMERA_FB_IN_PSRAM;
    c.grab_mode       = CAMERA_GRAB_LATEST;
    return c;
}

// A frame's length proves nothing — a torn frame still has a length, and cam_take() already
// guarantees an EOI marker, so both are satisfied by the banded/green garbage this board was
// producing. The only honest check is to decode it: jpg2rgb565 at 1/8 scale runs the real JPEG
// entropy decoder over the whole frame for ~100 KB of scratch, and fails on truncated or
// corrupt scan data.
inline bool frameDecodes(camera_fb_t* fb)
{
    if (fb->len < 4)
        return false;
    if (!(fb->buf[0] == 0xFF && fb->buf[1] == 0xD8))
        return false; // no SOI

    size_t   outLen = (size_t)(fb->width / 8) * (fb->height / 8) * 2;
    uint8_t* out    = (uint8_t*)heap_caps_malloc(outLen, MALLOC_CAP_SPIRAM);
    if (!out)
        return false;

    bool ok = jpg2rgb565(fb->buf, fb->len, out, JPG_SCALE_8X);
    free(out);
    return ok;
}

inline void tryOne(int xclk, framesize_t fs, const char* fsName, int fbCount)
{
    camera_config_t c = config(xclk, fs, fbCount);

    esp_err_t err = esp_camera_init(&c);
    if (err != ESP_OK)
    {
        LOG_E("CamTest", "xclk=%2d %-5s fb=%d -> init FAILED 0x%x", xclk / 1000000, fsName, fbCount, err);
        return;
    }

    sensor_t* s   = esp_camera_sensor_get();
    uint16_t  pid = s ? s->id.PID : 0;

    int    got = 0, valid = 0;
    size_t bytes = 0;
    for (int i = 0; i < 4; i++)
    {
        camera_fb_t* fb = esp_camera_fb_get();
        if (fb)
        {
            got++;
            bytes = fb->len;
            if (frameDecodes(fb))
                valid++;
            esp_camera_fb_return(fb);
        }
    }

    LOG_I("CamTest", "xclk=%2d %-5s fb=%d pid=0x%04X -> got %d/4, DECODED %d/4, last=%u bytes", xclk / 1000000, fsName,
          fbCount, pid, got, valid, (unsigned)bytes);

    esp_camera_deinit();
    delay(250);
}

inline void run()
{
    LOG_I("CamTest", "===== pre-network camera sweep =====");
    LOG_I("CamTest", "psram=%s free=%u internal=%u", psramFound() ? "yes" : "NO", (unsigned)ESP.getFreePsram(),
          (unsigned)ESP.getFreeHeap());
    LOG_I("CamTest", "pins xclk=%d pclk=%d vsync=%d href=%d sda=%d scl=%d", XCLK_GPIO_NUM, PCLK_GPIO_NUM,
          VSYNC_GPIO_NUM, HREF_GPIO_NUM, SIOD_GPIO_NUM, SIOC_GPIO_NUM);
    LOG_I("CamTest", "pins d0-d7 = %d %d %d %d %d %d %d %d", Y2_GPIO_NUM, Y3_GPIO_NUM, Y4_GPIO_NUM, Y5_GPIO_NUM,
          Y6_GPIO_NUM, Y7_GPIO_NUM, Y8_GPIO_NUM, Y9_GPIO_NUM);

    // 16 MHz first: that is the only value at which cam_hal enables psram_mode
    // (cam_hal.c:369, exact equality), so it is the configuration the shipped firmware uses.
    // 16 MHz is omitted: measured 0/4 at every resolution across three runs (psram_mode, which
    // this board's DMA cannot drive). What is still open is the usable ceiling on the two clocks
    // that do work, which is what decides the resolution cap.
    const int xclks[] = {20000000, 10000000};

    struct Size
    {
        framesize_t fs;
        const char* name;
    };
    const Size sizes[] = {{FRAMESIZE_VGA, "VGA"},
                          {FRAMESIZE_SVGA, "SVGA"},
                          {FRAMESIZE_XGA, "XGA"},
                          {FRAMESIZE_UXGA, "UXGA"},
                          {FRAMESIZE_QXGA, "QXGA"}};

    for (int x = 0; x < 2; x++)
        for (const Size& z : sizes)
            tryOne(xclks[x], z.fs, z.name, 2);

    LOG_I("CamTest", "===== sweep done =====");
}

} // namespace CameraSelfTest

#endif // HAS_CAMERA && CAMERA_SELFTEST
