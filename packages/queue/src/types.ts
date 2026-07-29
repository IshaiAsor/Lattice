export interface TelemetryArrivedPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  value: unknown;
  timestamp: string;
  // Present only for an on-demand camera capture (CameraAction.triggerCapture), threaded
  // through by device-gateway's HTTP/WS frame-upload paths; absent for periodic telemetry.
  // digest-service's handleImage() uses it to resolve the matching pending picture request.
  commandId?: string;
}

export interface RulesEvaluatePayload {
  userId: string;
  deviceId: string;
  actionName: string;
  value: unknown;
  timestamp: string;
}

export interface PipelineTriggerPayload {
  userId: string;
  pipelineId: string;
  runId: number;
  deviceId?: string;
  actionName?: string;
  value?: unknown;
  timestamp?: string;
  isDryRun?: boolean;
  sensorOverrides?: Record<string, string>;
}

export interface PipelineResultPayload {
  userId: string;
  pipelineId: string;
  pipelineRunId: string;
  status: 'completed' | 'failed';
  error?: string;
}

export interface PipelineCancelPayload {
  userId: string;
  pipelineId: string;
  runId: number;
}

export interface DeviceStateChangedPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  state: unknown;
  timestamp: string;
  version?: string;
}

// A device's periodic liveness ping, forwarded by mqtt-service off the .../heartbeat topic.
// Independent of telemetry so a device with no active sensors still proves it's alive; the
// metrics are cheap diagnostics (best-effort, may be absent on older firmware).
export interface DeviceHeartbeatPayload {
  userId: string;
  deviceId: string;
  version: string;
  timestamp: string;
  uptimeMs?: number;
  freeHeap?: number;
  rssi?: number;
}

// A UI client's request to change an action's state, addressed by UserDeviceAction id
// (the only handle the UI has). digest resolves it to a device/action/version and a
// concrete ActionDispatchPayload.
export interface ActionRequestedPayload {
  userId: string;
  actionId: number;
  value: unknown; // desired state value (e.g. "on", "23.5")
  duration?: string; // command duration hint passed through to the device
}

export interface ActionDispatchPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  command: unknown;
  commandId?: string; // correlates the device's ack back to the in-flight request
  firmwareVersion?: string;
}

// A device's acknowledgement that it executed (or rejected) a command. Published by the
// device on .../ack/{actionName}, forwarded by mqtt-service. digest writes the
// authoritative current_state ONLY on status 'ok'. commandId correlates back to the
// pending request for the in-flight UI; it is absent for unsolicited state changes the
// device reports on its own (boot restore, duration auto-off).
export interface ActionResultPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  commandId?: string;
  status: 'ok' | 'error';
  value?: unknown; // resulting state the device actually applied
  timestamp: string;
}

// ml-router's request for a fresh camera frame for a pipeline's enrich stage — published
// when the plan includes an image-flagged PipelineSensor. digest-service resolves actionId
// to a device (same as ActionRequestedPayload), dispatches the take_picture MQTT command,
// and arms a timeout.
export interface PictureRequestedPayload {
  userId: string;
  actionId: number;
  commandId: string;
  timeoutMs: number;
}

// digest-service's correlated response — either the captured frame (resolved via the same
// commandId carried through TelemetryArrivedPayload) or a timeout if the device never acked.
export interface PictureResultPayload {
  commandId: string;
  status: 'ok' | 'timeout';
  image?: string; // base64 JPEG
  capturedAt?: string;
}

export interface PipelineStagePayload {
  userId: string;
  deviceId: string;
  pipelineId: string;
  pipelineRunId: string;
  stageId: string;
  stageName: string;
  stageKind: string;
  context: Record<string, unknown>;
}

export interface PipelineStageDonePayload {
  pipelineRunId: string;
  stageId: string;
  status: 'completed' | 'failed';
  output?: Record<string, unknown>;
  error?: string;
}

export interface OtaDispatchPayload {
  deviceType: string;
  version: string;
  url: string;
  releaseNotes?: string;
  timestamp: string;
}

// A sealed device template was released/changed by an admin (api service). device-gateway
// consumes this and re-materializes every already-provisioned device the template matches,
// then pushes a config reload — the "apply migration" for sealed devices.
export interface SealedTemplateAppliedPayload {
  templateId: number;
  timestamp: string;
}

// Incoming OTA release trigger — published by ota-manager/CI, consumed by
// digest-service which validates + audit-logs, then forwards to OtaDispatchPayload.
// Shape mirrors OtaDispatchPayload for now but kept separate as it may diverge
// (e.g. carry CI metadata or an auth token).
export interface OtaIncomingPayload {
  deviceType: string;
  version: string;
  url: string;
  releaseNotes?: string;
  timestamp: string;
}

// Published best-effort by digest-service when a new OTA release passes validation.
// notification-service (F15) consumes this, resolves which users own a device of
// that type, and fans out per-user q.notification.send messages.
export interface NotificationPublishPayload {
  type: 'ota_available';
  deviceType: string;
  version: string;
}

// User-targeted notification request consumed by notification-service. Producers that already
// know the recipient publish this directly; the service resolves the user's per-channel/per-event
// preferences and fans out to the enabled channels (in-app socket, email, push).
//   - eventType keys the template + the preference matrix (e.g. 'emergency', 'rule_fired',
//     'device_offline', 'ota_available', 'email_verification').
//   - data is the template payload (rendered per channel); shape depends on eventType.
//   - dedupeKey (optional) overrides the default (userId, eventType) dedupe window.
//   - channels (optional) restricts delivery to a subset, still intersected with user prefs.
//   - context (optional, F10.7) is *where* this happened, not what happened. A user with several
//     Areas gets "Greenhouse · Automation triggered" instead of three identical alerts they have
//     to open to tell apart. It is separate from `data` because it is cross-cutting: any event
//     type can carry it, and templates prefix the title uniformly rather than each renderer
//     re-implementing it.
export interface NotificationSendPayload {
  userId: string;
  eventType: string;
  data: Record<string, unknown>;
  dedupeKey?: string;
  channels?: string[];
  context?: { area_id: number; area_name: string };
}
