#pragma once
#ifdef HAS_CAMERA

#include <Arduino.h>
#include <WebSocketsClient.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

struct WsFrame {
    uint8_t *buf;
    size_t   len;
};

class LiveStreamService
{
private:
    WebSocketsClient _ws;
    volatile bool    _connected = false;
    QueueHandle_t    _queue     = nullptr;
    TaskHandle_t     _task      = nullptr;
    String           _label     = "WS";

    // All WebSocketsClient calls are confined to this task (Core 0).
    // Main loop (Core 1) only interacts via _queue and _connected flag.
    static void wsTask(void *pv)
    {
        auto *self = static_cast<LiveStreamService *>(pv);
        WsFrame frame;
        for (;;)
        {
            self->_ws.loop();
            if (xQueueReceive(self->_queue, &frame, 0) == pdTRUE)
            {
                if (self->_connected)
                    self->_ws.sendBIN(frame.buf, frame.len);
                free(frame.buf);
            }
            vTaskDelay(1 / portTICK_PERIOD_MS);
        }
    }

    static void parseUrl(const String& url, bool validateCACert,
                         String& host, uint16_t& port, bool& useSSL)
    {
        useSSL = url.startsWith("https://") && validateCACert;
        String stripped = url;
        stripped.replace("https://", "");
        stripped.replace("http://",  "");
        int slashIdx = stripped.indexOf('/');
        String hostPort = slashIdx >= 0 ? stripped.substring(0, slashIdx) : stripped;
        int colonIdx = hostPort.indexOf(':');
        if (colonIdx >= 0)
        {
            host = hostPort.substring(0, colonIdx);
            port = (uint16_t)hostPort.substring(colonIdx + 1).toInt();
        }
        else
        {
            host = hostPort;
            port = useSSL ? 443 : 80;
        }
    }

public:
    void begin(const String& deviceConfigUrl, const String& token,
               bool validateCACert, const char* caCert = nullptr,
               const String& wsPath = "/ws/stream")
    {
        // Derive a short label and task name from the path for log readability
        _label = wsPath.endsWith("capture") ? "Capture" : "Stream";
        String taskName = _label == "Capture" ? "wsCapture" : "wsStream";

        String host; uint16_t port; bool useSSL;
        parseUrl(deviceConfigUrl, validateCACert, host, port, useSSL);
        String path = wsPath + "?token=" + token;
        Serial.printf("[%s] Connecting to %s:%u%s\n", _label.c_str(), host.c_str(), port, path.c_str());

        _ws.onEvent([this](WStype_t type, uint8_t*, size_t) {
            if (type == WStype_CONNECTED)    { _connected = true;  Serial.printf("[%s] WebSocket connected\n",    _label.c_str()); }
            if (type == WStype_DISCONNECTED) { _connected = false; Serial.printf("[%s] WebSocket disconnected\n", _label.c_str()); }
            if (type == WStype_ERROR)        {                     Serial.printf("[%s] WebSocket error\n",        _label.c_str()); }
        });

        _ws.setReconnectInterval(3000);
        // Ping every 15 s, expect pong within 3 s, disconnect after 2 missed pongs.
        // Keeps the TCP session alive through NAT/router idle-timeout windows.
        _ws.enableHeartbeat(15000, 3000, 2);

        if (useSSL) _ws.beginSslWithCA(host.c_str(), port, path.c_str(), caCert);
        else        _ws.begin(host.c_str(), port, path.c_str());

        _queue = xQueueCreate(3, sizeof(WsFrame));
        xTaskCreatePinnedToCore(wsTask, taskName.c_str(), 16384, this, 2, &_task, 0);
    }

    void loop() {}  // WS loop runs inside wsTask — nothing needed here

    bool isConnected() const { return _connected; }

    bool sendFrame(const uint8_t *buf, size_t len)
    {
        if (!_connected || !_queue) return false;

        uint8_t *copy = psramFound()
            ? (uint8_t *)ps_malloc(len)
            : (uint8_t *)malloc(len);
        if (!copy) { Serial.printf("[%s] malloc failed — dropping frame\n", _label.c_str()); return false; }

        memcpy(copy, buf, len);
        WsFrame frame = {copy, len};

        if (xQueueSend(_queue, &frame, 0) != pdTRUE)
        {
            free(copy);  // Queue busy — drop
            return false;
        }
        return true;
    }
};

#endif // HAS_CAMERA
