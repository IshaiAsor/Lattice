#pragma once

// Plain function pointer — no std::function overhead (no heap allocation on ESP32).
// Lambdas with no captures convert to this implicitly in C++11.
// Exists only to break the include cycle: mqtt.h → MqttActionsHandlerService.h → mqtt.h.
// Defined in main.cpp where MqttService lives; called from the MQTT callback and from
// BaseCommandAction for unsolicited state changes (auto-off, boot restore).
using AckPublisherFn = void (*)(const char* actionName, const char* commandId, bool ok, const char* value);
extern AckPublisherFn ackPublisher;

// Same pattern for publishing a telemetry reading — lets the MQTT handler route an on-demand
// read (the `read` verb on a read-surface action) to MqttService::publishTelemetry without a
// direct dependency on mqtt.h. Defined in main.cpp.
using TelemetryPublisherFn = void (*)(const char* actionName, const char* payload);
extern TelemetryPublisherFn telemetryPublisher;
