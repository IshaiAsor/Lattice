#pragma once
#include <Arduino.h>
#include <WiFiClient.h>
#include <WebSocketsClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "mqtt.h"
#include <actions/AckPublisher.h>
#include "PreferencesManagerService.h"
#include "JwtService.h"
#include "actions/DynamicDeviceActionsService.h"
#include "OtaService.h"
#include "config/Log.h"

extern DynamicDeviceActionsService deviceActionsService;

class MqttActionsHandlerService
{
  public:
    MqttActionsHandlerService();
    ~MqttActionsHandlerService();

    static void callback(char* topic, byte* payload, unsigned int length)
    {
        static OtaService* otaService = new OtaService(DEVICE_VERSION, DEVICE_TYPE, root_ca);
        LOG_D("Mqtt", "message arrived on topic: %s", topic);

        std::vector<char*> parts;

        char* token = std::strtok(topic, "/");
        while (token != nullptr)
        {
            parts.push_back(token);
            token = std::strtok(nullptr, "/");
        }

        if (parts.empty())
            return;

        String message;
        message.reserve(length);
        for (unsigned int i = 0; i < length; i++)
            message += (char)payload[i];

        // Everything below indexes parts[1/3/5/6], which only exist on the 7-part per-device
        // topic. The device subscribes to nothing else, but the broker is not a contract — a
        // shorter topic reaching this callback must bail before any of those reads.
        if (parts.size() < 7)
        {
            LOG_W("Mqtt", "unexpected topic format (%d parts) — ignoring", (int)parts.size());
            return;
        }

        char* userId     = parts[1];
        char* deviceId   = parts[3];
        char* actionType = parts[5];
        char* action     = parts[6];

        LOG_D("Mqtt", "userId=%s deviceId=%s actionType=%s action=%s", userId, deviceId, actionType, action);

        if (strcmp(actionType, "status") == 0)
        {
            LOG_D("Mqtt", "device %s status: %s", deviceId, message.c_str());
        }
        else if (strcmp(actionType, "command") == 0)
        {
            if (strcmp(action, "reprovision") == 0 || strcmp(action, "soft-reset") == 0)
            {
                LOG_I("Mqtt", "soft reset: clearing IoT credentials and restarting");
                PreferencesManagerService p;
                p.ClearCredentials();
                ESP.restart();
                return;
            }
            if (strcmp(action, "hard-reset") == 0)
            {
                LOG_I("Mqtt", "hard reset: erasing all NVS data and restarting");
                PreferencesManagerService p;
                p.ClearAllCredentials();
                ESP.restart();
                return;
            }
            if (strcmp(action, "restart") == 0)
            {
                LOG_I("Mqtt", "restart: rebooting device");
                ESP.restart();
                return;
            }
            // Firmware update — now the only way one arrives. This device is named in the topic,
            // so an update reaches it and nothing else; the `ota/updates/<deviceType>` broadcast
            // that used to sit beside this branch flashed every connected device of the type.
            // OtaService logs and acks the outcome, and authenticates the download with the
            // device's current JWT.
            if (strcmp(action, "ota") == 0)
            {
                JwtToken* jwt = jwtService.GetCurrentJwtToken();
                otaService->handleUpdateMessage(message.c_str(), jwt ? jwt->token.c_str() : "", ackPublisher);
                return;
            }
#ifdef HAS_CAMERA
            // Legacy take_picture alias — equivalent to `read` on the camera's read surface.
            // Kept so not-yet-updated backend publishers keep working; new code sends `read`.
            if (strcmp(action, "take_picture") == 0)
            {
                JsonDocument doc;
                deserializeJson(doc, message);
                String commandId = doc["commandId"] | "";
                deviceActionsService.triggerPictureCapture(commandId);
                return;
            }
#endif
            DeviceAction* deviceAction = deviceActionsService.getActionByName(action);

            // Reserved `read` verb — never validated, never executes. On a read surface it
            // triggers an on-demand reading (sensor sample / camera capture); on a command-only
            // action it reports the current NVS-persisted state on the ack topic. Intercepted
            // before execute() so it never reaches the parity-critical validateActionPayload.
            {
                JsonDocument rdoc;
                if (deviceAction != nullptr && deserializeJson(rdoc, message) == DeserializationError::Ok &&
                    strcmp(rdoc["value"] | "", "read") == 0)
                {
                    String commandId = rdoc["commandId"] | "";
                    if (deviceAction->hasReadSurface())
                    {
                        // On-demand read is gated on the `on_demand` behavior.
                        if (deviceAction->onDemandEnabled())
                        {
                            LOG_D("Cmd", "read verb: on-demand read of '%s'", action);
                            deviceAction->readNow(telemetryPublisher, commandId);
                        }
                        else
                        {
                            LOG_W("Cmd", "read verb rejected: '%s' has no on_demand behavior", action);
                            if (ackPublisher)
                                ackPublisher(action, commandId.c_str(), false, "on_demand_disabled");
                        }
                    }
                    else
                    {
                        // Command action state report (always available, not a toggled behavior).
                        LOG_D("Cmd", "read verb: reporting state for '%s'", action);
                        if (ackPublisher)
                            ackPublisher(action, commandId.c_str(), true, deviceAction->getState().c_str());
                    }
                    return;
                }
            }

            if (deviceAction != nullptr && deviceAction->hasCommandSurface())
            {
                // Value commands are gated on the `command` behavior.
                if (!deviceAction->commandEnabled())
                {
                    LOG_W("Cmd", "command rejected: '%s' has no command behavior", action);
                    if (ackPublisher)
                        ackPublisher(action, "", false, "command_disabled");
                    return;
                }
                ActionResult result = deviceAction->execute(message);
                LOG_D("Mqtt", "action '%s' result: %s, commandId=%s, value=%s", action, result.ok ? "OK" : "FAIL",
                      result.commandId.c_str(), result.value.c_str());
                if (ackPublisher)
                    ackPublisher(action, result.commandId.c_str(), result.ok, result.value.c_str());
                return;
            }
            LOG_W("Mqtt", "no command action found for: %s", action);
        }
        else if (strcmp(actionType, "telemetry") == 0)
        {
            LOG_D("Mqtt", "received telemetry action=%s message=%s", action, message.c_str());
        }
        else
        {
            LOG_W("Mqtt", "unknown action type: %s", actionType);
        }
    }
};
