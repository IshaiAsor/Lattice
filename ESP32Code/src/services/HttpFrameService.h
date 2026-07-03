#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

struct HttpFrame {
    uint8_t *buf;
    size_t   len;
    char     action[64];      // mqtt_action_name this frame belongs to
    char     commandId[40];   // empty = periodic push; set = on-demand capture correlation
};

class HttpFrameService
{
private:
    String        _baseUrl;
    String        _token;
    bool          _useSSL   = false;
    const char   *_caCert   = nullptr;
    QueueHandle_t _queue    = nullptr;
    TaskHandle_t  _task     = nullptr;

    static void httpTask(void *pv)
    {
        auto *self = static_cast<HttpFrameService *>(pv);
        HttpFrame frame;

        WiFiClient       plain;
        WiFiClientSecure ssl;
        if (self->_useSSL)
        {
            if (self->_caCert) ssl.setCACert(self->_caCert);
            else               ssl.setInsecure();
        }

        HTTPClient http;

        for (;;)
        {
            if (xQueueReceive(self->_queue, &frame, pdMS_TO_TICKS(100)) != pdTRUE)
                continue;

            String url = self->_baseUrl + "/api/camera/frame?action=" + frame.action;
            if (frame.commandId[0] != '\0') url += "&commandId=" + String(frame.commandId);

            bool begun = self->_useSSL
                ? http.begin(ssl,   url)
                : http.begin(plain, url);

            if (!begun)
            {
                Serial.printf("[HTTP Cam] begin() failed for %s\n", url.c_str());
                free(frame.buf);
                continue;
            }

            http.addHeader("Authorization", "Bearer " + self->_token);
            http.addHeader("Content-Type",  "image/jpeg");

            int code = http.POST(frame.buf, frame.len);
            if (code < 0)
                Serial.printf("[HTTP Cam] POST error %d (%s)\n", code,
                              http.errorToString(code).c_str());
            else if (code != 200)
                Serial.printf("[HTTP Cam] POST -> HTTP %d\n", code);

            free(frame.buf);
        }
    }

public:
    void begin(const String& cameraHttpUrl, const String& token,
               bool validateCA, const char* caCert = nullptr)
    {
        _baseUrl = cameraHttpUrl;
        // Strip trailing slash for clean URL construction
        while (_baseUrl.endsWith("/")) _baseUrl.remove(_baseUrl.length() - 1);

        _token  = token;
        _useSSL = validateCA && cameraHttpUrl.startsWith("https");
        _caCert = caCert;

        _queue = xQueueCreate(3, sizeof(HttpFrame));
        xTaskCreatePinnedToCore(httpTask, "httpCam", 16384, this, 1, &_task, 1);
        Serial.printf("[HTTP Cam] Ready -> %s\n", _baseUrl.c_str());
    }

    bool isReady() const { return _queue != nullptr; }

    bool sendFrame(const uint8_t *buf, size_t len, const String& actionName, const String& commandId = "")
    {
        if (!_queue) return false;

        uint8_t *copy = psramFound()
            ? (uint8_t *)ps_malloc(len)
            : (uint8_t *)malloc(len);
        if (!copy)
        {
            Serial.println("[HTTP Cam] malloc failed — dropping frame");
            return false;
        }

        memcpy(copy, buf, len);
        HttpFrame frame;
        frame.buf = copy;
        frame.len = len;
        strlcpy(frame.action, actionName.c_str(), sizeof(frame.action));
        strlcpy(frame.commandId, commandId.c_str(), sizeof(frame.commandId));

        if (xQueueSend(_queue, &frame, 0) != pdTRUE)
        {
            free(copy);  // queue busy — drop
            return false;
        }
        return true;
    }
};

#endif // HAS_CAMERA
