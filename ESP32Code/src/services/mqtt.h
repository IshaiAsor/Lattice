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

    bool reconnectMqtt()
    {
        LOG_I("Mqtt", "attempting to reconnect to MQTT");
        if (jwtData == nullptr)
        {
            LOG_D("Mqtt", "no cached JWT — loading from storage");
            jwtData = jwtService.GetCurrentJwtToken();
            if (!jwtData)
            {
                LOG_E("Mqtt", "no JWT token available — cannot connect");
                return false;
            }
        }
        if (creds == nullptr)
        {
            LOG_D("Mqtt", "no cached credentials — loading from storage");
            creds = prefService.LoadMqttServerCredentials();

            if (!creds)
            {
                LOG_E("Mqtt", "no MQTT credentials available — cannot connect");
                return false;
            }
        }

#ifndef ENV_TEST
        // Prod always validates against the pinned CA (set once in the ctor; re-affirm here
        // in case credentials changed).
        static_cast<WiFiClientSecure&>(espClient).setCACert(root_ca);
#endif

        client->setServer(creds->server.c_str(), creds->port);
        buildTopics();

        int       attempt      = 0;
        const int max_attempts = 5;

        while (!client->connected() && attempt < max_attempts)
        {
            if (client->connect(creds->clientId.c_str(), creds->userId.c_str(), jwtData->token.c_str(),
                                _statusTopic.c_str(), 0, true, "offline"))
            {
                client->publish(_statusTopic.c_str(), "online", true);
                client->subscribe(_commandTopic.c_str());
                client->subscribe(_otaTopic.c_str());

                LOG_I("Mqtt", "connected and subscribed to topics");
            }
            else
            {
#ifndef ENV_TEST
                char err_buf[100];
                static_cast<WiFiClientSecure&>(espClient).lastError(err_buf, 100);
                LOG_W("Mqtt", "connect failed, rc=%d | SSL error: %s — retry in 5s", client->state(), err_buf);
#else
                LOG_W("Mqtt", "connect failed, rc=%d — retry in 5s", client->state());
#endif
                delay(5000);
                attempt++;
            }
        }

        if (!client->connected())
        {
            LOG_E("Mqtt", "max connection attempts reached");
            return false;
        }
        return true;
    }

    bool loopMqtt()
    {
        if (client != nullptr && client->connected())
        {
            if (jwtData == nullptr)
            {
                LOG_D("Mqtt", "no cached JWT — loading from storage");
                jwtData = jwtService.GetCurrentJwtToken();
                if (!jwtData)
                {
                    LOG_E("Mqtt", "cannot retrieve JWT for refresh — clearing credentials and restarting");
                    prefService.ClearCredentials();
                    ESP.restart();
                }
            }
            if (!jwtService.RefreshJwtTokenIfNeeded())
            {
                LOG_E("Mqtt", "JWT refresh failed — clearing credentials and restarting");
                prefService.ClearCredentials();
                ESP.restart();
            }
            client->loop();
            return true;
        }
        else
        {
            LOG_W("Mqtt", "client disconnected (state=%d) — attempting to reconnect", client->state());
            if (!reconnectMqtt())
            {
                LOG_E("Mqtt", "failed to reconnect to MQTT");
                prefService.ClearCredentials();
                return false;
            }
            return true;
        }
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
