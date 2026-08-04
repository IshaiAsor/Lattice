#pragma once
#include <Arduino.h>
#include <string>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "PreferencesManagerService.h"
#include "JwtService.h"
#include "config/settings.h"
#include "MqttActionsHandlerService.h"
#include "certs/cert.h"
#include "OtaService.h"
#include "services/TopicBuilder.h"
#include "config/Log.h"
class MqttService
{
  private:
    const char*                root_ca = certificate_root;
    Client&                    espClient;
    PubSubClient*              client = nullptr;
    PreferencesManagerService  prefService;
    JwtService&                jwtService;
    JwtToken*                  jwtData = nullptr;
    MqttCredentials*           creds   = nullptr;
    MqttActionsHandlerService* mqttActionsHandler;
    OtaService*                otaService = nullptr;

    // Topics resolved once per (re)connect from creds — they only change when creds change,
    // so publishTelemetry/publishAck (hot paths) reuse these instead of rebuilding + doing
    // three placeholder replacements on every message. The two *Base strings still carry the
    // trailing "#" slot, substituted per-action at publish time.
    std::string _commandTopic;
    std::string _statusTopic;
    std::string _otaTopic;
    std::string _telemetryBase;
    std::string _ackBase;
    std::string _heartbeatTopic;

    // Reconnect backoff. A router restart takes the broker out of reach for minutes, so
    // attempts widen from MQTT_BACKOFF_MIN_MS to MQTT_BACKOFF_MAX_MS and simply keep going.
    // This replaces the old "5 blocking attempts, then wipe the stored credentials" path —
    // 25 s of unreachable broker used to cost the device its provisioning permanently.
    unsigned long _nextAttemptMs = 0;
    unsigned long _backoffMs     = MQTT_BACKOFF_MIN_MS;

    // Buffer size + keep-alive are identical config for the live and the probe client; the
    // #ifdef HAS_CAMERA buffer split lived in two places before.
    void tuneClient(PubSubClient& c, uint16_t keepAliveSec)
    {
#ifdef HAS_CAMERA
        c.setBufferSize(65535);
#else
        c.setBufferSize(2048);
#endif
        c.setKeepAlive(keepAliveSec);
    }

    void buildTopics()
    {
        const std::string uid = creds->userId.c_str();
        const std::string did = creds->clientId.c_str();
        const std::string ver = DEVICE_VERSION;
        _commandTopic         = TopicBuilder::build(COMMAND_TOPIC, uid, did, ver);
        _statusTopic          = TopicBuilder::build(STATUS_TOPIC, uid, did, ver);
        _otaTopic             = TopicBuilder::buildForDeviceType(OTA_TOPIC, DEVICE_TYPE);
        _telemetryBase        = TopicBuilder::build(TELEMETRY_TOPIC, uid, did, ver);
        _ackBase              = TopicBuilder::build(ACK_TOPIC, uid, did, ver);
        _heartbeatTopic       = TopicBuilder::build(HEARTBEAT_TOPIC, uid, did, ver);
    }

  public:
    MqttService(Client& espClient, JwtService& jwtService) : espClient(espClient), jwtService(jwtService)
    {
#ifndef ENV_TEST
        WiFiClientSecure& secureCli = static_cast<WiFiClientSecure&>(espClient);
        secureCli.setCACert(root_ca);
        secureCli.setHandshakeTimeout(10000);
#endif
        client = new PubSubClient(espClient);
        tuneClient(*client, 60);
        client->setCallback(MqttActionsHandlerService::callback);
        otaService = new OtaService(DEVICE_VERSION, DEVICE_TYPE, root_ca);
    }
    ~MqttService() {};

    bool connected() { return client->connected(); }

    bool testMqtt(MqttCredentials* creds, JwtToken* token)
    {
        LOG_I("Mqtt", "attempting to connect to MQTT");
#ifdef ENV_TEST
        WiFiClient testClient;
#else
        // Prod always validates against the pinned CA (no insecure fallback).
        WiFiClientSecure testClient;
        testClient.setCACert(root_ca);
        testClient.setHandshakeTimeout(10000);
#endif
        PubSubClient testPubSubClient(testClient);
        tuneClient(testPubSubClient, 10);
        testPubSubClient.setServer(creds->server.c_str(), creds->port);

        int       attempt      = 0;
        const int max_attempts = 5;

        while (!testPubSubClient.connected() && attempt < max_attempts)
        {
            if (testPubSubClient.connect(creds->clientId.c_str(), creds->userId.c_str(), token->token.c_str()))
            {
                LOG_I("Mqtt", "test connection succeeded");
            }
            else
            {
#ifndef ENV_TEST
                char err_buf[100];
                testClient.lastError(err_buf, 100);
                LOG_W("Mqtt", "test connect failed, rc=%d | SSL error: %s — retry in 5s", testPubSubClient.state(),
                      err_buf);
#else
                LOG_W("Mqtt", "test connect failed, rc=%d — retry in 5s", testPubSubClient.state());
#endif
                delay(5000);
                attempt++;
            }
        }

        if (!testPubSubClient.connected())
        {
            LOG_E("Mqtt", "max test connection attempts reached");
            return false;
        }
        return true;
    }

    // A single connect attempt. Never blocks on retries and never touches stored
    // credentials: failing here is the expected state during a network outage, and the
    // caller schedules the next attempt.
    bool reconnectMqtt()
    {
        LOG_I("Mqtt", "attempting to reconnect to MQTT");

        // Re-fetch rather than cache: JwtService may replace the token object on refresh, so
        // a pointer held across refreshes would dangle.
        jwtData = jwtService.GetCurrentJwtToken();
        if (!jwtData)
        {
            LOG_W("Mqtt", "no usable JWT (storage empty or refresh unreachable) — will retry");
            return false;
        }
        if (creds == nullptr)
        {
            LOG_D("Mqtt", "no cached credentials — loading from storage");
            creds = prefService.LoadMqttServerCredentials();

            if (!creds)
            {
                LOG_E("Mqtt", "no MQTT credentials available — device needs provisioning");
                return false;
            }
        }

#ifndef ENV_TEST
        // Prod always validates against the pinned CA (set once in the ctor; re-affirm here
        // in case credentials changed).
        static_cast<WiFiClientSecure&>(espClient).setCACert(root_ca);
#endif
        // Release the dead TLS session before opening a new one. On the no-PSRAM classic
        // ESP32 boards mbedTLS's ~40 KB of record buffers come out of fragmented internal
        // DRAM, and leaving the previous context allocated is by itself enough to make the
        // next handshake fail with MBEDTLS_ERR_SSL_ALLOC_FAILED.
        espClient.stop();

        client->setServer(creds->server.c_str(), creds->port);
        buildTopics();

        if (client->connect(creds->clientId.c_str(), creds->userId.c_str(), jwtData->token.c_str(),
                            _statusTopic.c_str(), 0, true, "offline"))
        {
            client->publish(_statusTopic.c_str(), "online", true);
            client->subscribe(_commandTopic.c_str());
            client->subscribe(_otaTopic.c_str());

            LOG_I("Mqtt", "connected and subscribed to topics");
            return true;
        }

#ifndef ENV_TEST
        char err_buf[100];
        static_cast<WiFiClientSecure&>(espClient).lastError(err_buf, 100);
        LOG_W("Mqtt", "connect failed, rc=%d | SSL error: %s", client->state(), err_buf);
#else
        LOG_W("Mqtt", "connect failed, rc=%d", client->state());
#endif
        return false;
    }

    // Services the MQTT session. Returns whether the broker is connected *right now* — a
    // false return is a status for the caller's LED, never a reason to reboot or to clear
    // credentials. Transient failures are retried on a widening backoff, indefinitely.
    bool loopMqtt()
    {
        if (client == nullptr)
            return false;

        if (client->connected())
        {
            _backoffMs     = MQTT_BACKOFF_MIN_MS;
            _nextAttemptMs = 0;

            // Best-effort. A failed refresh means the refresh endpoint is unreachable (WAN
            // still down after a router restart) or the token is stale — neither invalidates
            // the session already held, and the next tick tries again.
            if (!jwtService.RefreshJwtTokenIfNeeded())
                LOG_W("Mqtt", "JWT refresh failed — keeping current session, will retry");

            client->loop();
            return true;
        }

        unsigned long now = millis();
        if (_nextAttemptMs != 0 && (long)(now - _nextAttemptMs) < 0) // rollover-safe compare
            return false;                                            // inside the backoff window

        LOG_W("Mqtt", "client disconnected (state=%d) — attempting to reconnect", client->state());
        if (reconnectMqtt())
        {
            _backoffMs     = MQTT_BACKOFF_MIN_MS;
            _nextAttemptMs = 0;
            return true;
        }

        _nextAttemptMs = now + _backoffMs;
        LOG_W("Mqtt", "reconnect failed — next attempt in %lu ms", _backoffMs);
        _backoffMs = (_backoffMs > MQTT_BACKOFF_MAX_MS / 2) ? MQTT_BACKOFF_MAX_MS : _backoffMs * 2;
        return false;
    }

    void publishTelemetry(const char* actionType, const char* payload)
    {
        if (client != nullptr && client->connected())
        {
            std::string topic = TopicBuilder::replaceAll(_telemetryBase, "#", actionType);
            client->publish(topic.c_str(), payload);
        }
        else
        {
            LOG_W("Mqtt", "cannot publish telemetry: client not connected");
        }
    }

    // Liveness ping — lets the backend distinguish "alive but quiet" (no active telemetry
    // actions) from "gone" without waiting on the retained-status Last-Will, and carries a
    // few cheap diagnostics. Best-effort QoS 0, no ack; a lost heartbeat just shortens the
    // device's last-seen window. No-op until MQTT is connected.
    void publishHeartbeat()
    {
        if (client == nullptr || !client->connected())
        {
            LOG_D("Mqtt", "cannot publish heartbeat: client not connected");
            return;
        }
        JsonDocument doc;
        doc["uptimeMs"] = millis();
        doc["freeHeap"] = ESP.getFreeHeap();
        doc["rssi"]     = WiFi.RSSI();
        doc["version"]  = DEVICE_VERSION;

        String payload;
        serializeJson(doc, payload);
        client->publish(_heartbeatTopic.c_str(), payload.c_str(), false);
        LOG_D("Mqtt", "heartbeat published");
    }

    // Acknowledge a command's execution back to the backend so it can write the
    // authoritative state. Body: {"commandId":"...","status":"ok|error","value":"..."}.
    // commandId is omitted for unsolicited changes (auto-off, boot restore). Published at
    // PubSubClient's QoS 0 (its only level); the backend's no-ack timeout covers a lost
    // ack. No-op if MQTT/creds aren't ready yet (e.g. boot state restore before the first
    // connect) — the backend reconciles via periodic telemetry in that case.
    void publishAck(const char* actionName, const char* commandId, bool ok, const char* value)
    {
        LOG_D("Mqtt", "publishing ack for '%s': %s, commandId=%s, value=%s", actionName, ok ? "OK" : "FAIL", commandId,
              value);

        if (client == nullptr || !client->connected() || creds == nullptr)
        {
            LOG_W("Mqtt", "cannot publish ack: client not connected");
            return;
        }
        std::string ackTopic = TopicBuilder::replaceAll(_ackBase, "#", actionName);

        JsonDocument doc;
        if (commandId != nullptr && strlen(commandId) > 0)
            doc["commandId"] = commandId;
        doc["status"] = ok ? "ok" : "error";
        doc["value"]  = value;

        String payload;
        serializeJson(doc, payload);
        client->publish(ackTopic.c_str(), payload.c_str(), false);
    }
};
