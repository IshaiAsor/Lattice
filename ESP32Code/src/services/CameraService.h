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
// Per-sensor JPEG quality (esp32-camera scale: LOWER number = less compression = BIGGER frame).
// Frame size is the binding constraint on this platform's DMA path, so these are the primary
// tuning knob and are overridable per board at build time, e.g.
//     PLATFORMIO_BUILD_FLAGS='-D OV5640_JPEG_QUALITY=10'
// Both defaults are measured on hardware by capturing frames and looking at them — see
// applyTuning() for the evidence.
// XCLK fed to the sensor. 10 MHz is measured-best on this board for both sensors tested, and
// the obvious intuition — that a 5 MP sensor wants a faster clock — is wrong here: raising it to
// 24 MHz for the OV5640 made the image visibly WORSE, heavy grain and a magenta cast, with the
// JPEG inflating from 344 KB to 922 KB on the same scene purely from noise. That points at
// signal integrity on the parallel bus rather than at the sensor.
// Overridable per board, e.g. PLATFORMIO_BUILD_FLAGS='-D CAMERA_XCLK_HZ=20000000'.
// NOTE 16000000 exactly is special and must be avoided — see pinConfig().
#ifndef CAMERA_XCLK_HZ
#define CAMERA_XCLK_HZ 10000000
#endif

#ifndef OV3660_JPEG_QUALITY
#define OV3660_JPEG_QUALITY 14
#endif
#ifndef OV5640_JPEG_QUALITY
#define OV5640_JPEG_QUALITY 12
#endif

class CameraService
{
  public:
    static bool init()
    {
        if (_ready)
            return true;

        _config          = pinConfig();
        const bool psram = psramFound();
        if (psram)
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

        // At INFO, not DEBUG: this branch decides frame size, buffer count and whether the driver
        // can hold a full JPEG at all, so it is the first thing worth knowing when frames stop
        // arriving. `psram=NO` on a board built with BOARD_HAS_PSRAM means the PSRAM mode is wrong
        // (memory_type qio_opi assumes octal), and every later resolution grow is then allocating
        // against internal DRAM.
        LOG_I("Camera", "init: psram=%s frame=%ux%u quality=%d fb_count=%d xclk=%d Hz", psram ? "yes" : "NO",
              (unsigned)resolution[_config.frame_size].width, (unsigned)resolution[_config.frame_size].height,
              _config.jpeg_quality, _config.fb_count, _config.xclk_freq_hz);

        esp_err_t err = esp_camera_init(&_config);
        if (err != ESP_OK)
        {
            LOG_E("Camera", "init failed: 0x%x", err);
            return false;
        }
        _ready = true;

        sensor_t* s = esp_camera_sensor_get();
        _sensorPid  = s ? s->id.PID : 0;
        LOG_I("Camera", "sensor PID: 0x%04X", _sensorPid);

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

        int captured = settle(5);

        if (captured == 0)
        {
            // _ready deliberately stays true: the driver is up and a later capture may still
            // succeed (AEC still settling, transient bus noise), so the read surface keeps trying
            // and keeps reporting. The return value is what tells the caller this camera is suspect.
            LOG_E("Camera", "init: driver up but 0/5 warmup frames captured — this camera will not "
                            "produce images (check data-bus wiring, xclk_freq_hz, and whether the "
                            "JPEG overruns the driver buffer)");
            return false;
        }

        LOG_I("Camera", "ready (%d/5 warmup frames)", captured);
        return true;
    }

    static bool isReady() { return _ready; }

    // Runs the sensor for a few frames and discards them so auto-exposure and auto-white-balance
    // converge before anything real is captured. Returns how many actually arrived — the only
    // signal available that the data path works, since the Arduino framework links a prebuilt
    // libesp32-camera.a with every diagnostic string stripped.
    static int settle(int frames)
    {
        int captured = 0;
        for (int i = 0; i < frames; i++)
        {
            camera_fb_t* fb = esp_camera_fb_get();
            if (fb)
            {
                captured++;
                LOG_D("Camera", "settle frame %d: %u bytes", i, (unsigned)fb->len);
                esp_camera_fb_return(fb);
            }
        }
        return captured;
    }

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

        // Clamp to what the fitted sensor can actually produce. Overshooting is not a harmless
        // no-op: the grow path below would deinit and reinit the driver for a frame size the
        // sensor cannot deliver, and esp_camera_init() reports ESP_OK for it — the camera then
        // simply never returns a frame, which is indistinguishable from dead hardware. The UI
        // offers all 13 framesizes to every camera regardless of sensor (see F3.20).
        const framesize_t cap = maxFramesize();
        if (pixelCount(fs) > pixelCount(cap))
        {
            LOG_W("Camera", "requested %ux%u exceeds sensor 0x%04X maximum %ux%u — clamping",
                  (unsigned)resolution[fs].width, (unsigned)resolution[fs].height, _sensorPid,
                  (unsigned)resolution[cap].width, (unsigned)resolution[cap].height);
            fs = cap;
        }

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

            // A reinit restarts the sensor cold: AEC/AWB are back at their defaults, so the next
            // frames come out underexposed and banded. init()'s warm-up ran before this point and
            // cannot cover it — without re-settling here, any camera configured above the init
            // default delivered dark, noisy images that still decoded as valid JPEG. More frames
            // than at init because the larger readout takes longer to converge.
            settle(8);
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

    // Largest frame each sensor can produce, by SCCB-reported PID. This is a sensor-capability
    // ceiling; the *bandwidth* ceiling is handled by jpeg_quality in applyTuning(), not here.
    //
    // Those two were confused for a while and it cost a lot of debugging: at the old quality 8 the
    // OV3660 banded at anything above SVGA, which looked exactly like a resolution limit. It was
    // frame size. At quality 14 the same sensor is clean at its full QXGA, so the cap belongs
    // where the datasheet puts it.
    //
    // Exceeding a sensor's real maximum is not a harmless overshoot: applyResolution() would
    // deinit and reinit the driver for a size the sensor cannot deliver, esp_camera_init()
    // returns ESP_OK for it, and captures then time out forever.
    static framesize_t maxFramesize()
    {
        switch (_sensorPid)
        {
        case 0x2640:                // OV2640 — 2 MP
            return FRAMESIZE_UXGA;  // 1600x1200
        case 0x3660:                // OV3660 — 3 MP, verified clean to QXGA at quality 14
            return FRAMESIZE_QXGA;  // 2048x1536
        case 0x5640:                // OV5640 — 5 MP
            return FRAMESIZE_QSXGA; // 2560x1920
        default:
            return FRAMESIZE_SVGA; // unknown sensor: stay at init()'s safe default
        }
    }

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
        // 10 MHz. Both of the obvious values are wrong on this board, in different ways, and the
        // difference is invisible unless you decode the frame — a torn frame still has a length,
        // and cam_take() already guarantees an EOI marker, so "got a frame" proves nothing.
        //
        // Measured on hardware (OV3660, pre-network sweep in CameraSelfTest.h, fb_count=2,
        // frames per 4 attempts that fully decode via jpg2rgb565):
        //
        //     xclk    VGA   SVGA   XGA   UXGA   QXGA
        //     16MHz   0/4   0/4    0/4   0/4    0/4
        //     20MHz   4/4   4/4    4/4   2/4    corrupt
        //     10MHz   4/4   4/4    4/4   4/4    4/4     <- 394,960 B at QXGA, clean
        //
        // 16 MHz is the exact value that enables cam_hal's psram_mode (cam_hal.c:369, exact
        // equality). That path does not work on this board at all: every capture times out, while
        // esp_camera_init() still returns ESP_OK and SCCB still reads the sensor PID — a camera
        // that looks perfectly healthy and produces nothing.
        //
        // 20 MHz drops psram_mode and DMAs through the internal-DRAM ring instead. That works up
        // to XGA, but above it the ring cannot keep up with the pixel rate: frames arrive with a
        // valid EOI and corrupt scan data (green banding/tearing), which is exactly the failure
        // the original 16 MHz comment predicted for this branch.
        //
        // 10 MHz uses the same non-PSRAM ring but halves the pixel rate, so the ring keeps up all
        // the way to the sensor's QXGA maximum. Re-run the sweep before changing this again, and
        // judge it on the DECODED column, never on byte counts.
        config.xclk_freq_hz = CAMERA_XCLK_HZ;
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
            // 14, not 8. jpeg_quality is inverted — a lower number means less compression and a
            // BIGGER frame — and frame size is what this platform's DMA path runs out of. At 8 a
            // QXGA frame is ~450 KB and arrives shredded with horizontal banding; at 14 the same
            // scene is ~89 KB and is clean at every resolution the sensor offers. Measured by
            // capturing and looking at frames: q8 banded above SVGA, q14 clean through QXGA.
            // Raise this number (more compression) before lowering the resolution if banding
            // ever returns; the two trade against each other and quality is the cheaper give.
            s->set_quality(s, OV3660_JPEG_QUALITY);
            s->set_sharpness(s, 2);
            s->set_contrast(s, 1);
            s->set_saturation(s, 0);
            LOG_I("Camera", "OV3660: q%d", OV3660_JPEG_QUALITY);
        }
        else if (_sensorPid == 0x5640)
        { // OV5640
            // 10, measured on an OV5640-AF at QSXGA (2560x1920), xclk 10 MHz, by capturing
            // frames and looking at them:
            //
            //     q8   no frame at all — too large, the DMA path drops every one
            //     q10  clean, 819-854 KB, 0 capture failures — but see the transport limit below
            //     q12  clean, 344-671 KB, 0 capture failures      <- default
            //
            // The original 6 was never measured and sits below the q8 that fails outright, so it
            // would have produced a camera that silently captured nothing.
            //
            // q10 is one step off the cliff, deliberately: frame size is scene-dependent (the
            // same q12 measured 344 KB on a dim scene and 671 KB on a bright one), so a very
            // detailed scene could push q10 into q8's failure mode. Drop to 12 if that shows up
            // as intermittent missing frames — it costs little visible quality.
            //
            // Capture is NOT the binding constraint here — delivery is, in two separate ways.
            //
            // 1. The frame reaches the UI as a base64 string over socket.io
            //    (digest-service telemetry.consumer.ts -> emitActionStateUpdate), and socket.io's
            //    default maxHttpBufferSize is 1 MB. Base64 costs 33%, so the JPEG must stay under
            //    ~750 KB or the packet is dropped and the client is disconnected. q10 at QSXGA
            //    produces 819-854 KB — over the line, which silently breaks the camera in the UI
            //    while capture, upload and storage all keep working perfectly. q12 stays under it.
            //    Raise maxHttpBufferSize on socket-server if a bigger frame is ever wanted.
            //
            // 2. The frame rate at QSXGA is capped by the HTTPS upload, not the sensor: ~0.5 Hz
            //    against a 1 s interval at both q10 and q12, with zero capture failures. Lower the
            //    resolution for a sustained 1 Hz.
            s->set_quality(s, OV5640_JPEG_QUALITY);
            s->set_sharpness(s, 2);
            s->set_contrast(s, 1);
            s->set_saturation(s, 1);
            LOG_I("Camera", "OV5640: q%d", OV5640_JPEG_QUALITY);
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
