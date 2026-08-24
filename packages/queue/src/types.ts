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
  // Who observed the change. 'broker' is a status message the broker delivered (including its
  // Last-Will); 'reaper' is automation-worker inferring death from missed heartbeats, which is the
  // case the broker never witnesses. Optional so an older publisher still validates — absent reads
  // as 'broker', the only source that existed before. Consumed by the device timeline (F18.1),
  // where "we inferred this" and "the broker told us" are different levels of confidence.
  source?: 'broker' | 'reaper';
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
/**
 * Who raised a command, recorded with it in `device_commands`.
 *
 * `refId` is the rule/scene/pipeline row id and `label` its name at the time — the label is stored
 * as text on purpose, so the history still reads correctly after that automation is renamed or
 * deleted. `device` is the device acting on its own (a duration auto-off releasing, a boot restore),
 * which is an ack with no command behind it.
 */
export interface CommandSource {
  kind: 'manual' | 'rule' | 'scene' | 'pipeline' | 'phase' | 'device' | 'system';
  refId?: number;
  label?: string;
}

export interface ActionRequestedPayload {
  userId: string;
  actionId: number;
  value: unknown; // desired state value (e.g. "on", "23.5")
  duration?: string; // command duration hint passed through to the device
  source?: CommandSource;
}

// A request to ask the device what state it is actually in. The inverse of
// ActionRequestedPayload: that one carries intent, this one carries none. digest resolves the
// action, dispatches the firmware's reserved `read` verb, and lets the ack correct current_state
// if it diverged. `reason` is diagnostic — it says which of the four triggers raised the read
// (the periodic sweep, a device reconnecting, an unsettled command, or a user pressing refresh)
// and is carried into the metrics label rather than changing any behaviour.
export interface ActionReadRequestedPayload {
  userId: string;
  deviceId: string;
  actionId: number;
  reason: 'sweep' | 'reconnect' | 'unsettled' | 'manual';
}

export interface ActionDispatchPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  command: unknown;
  commandId?: string; // correlates the device's ack back to the in-flight request
  firmwareVersion?: string;
  source?: CommandSource;
  /** The UserDeviceAction this addresses, when the publisher already knows it. */
  actionId?: number;
  /**
   * This dispatch carries the `read` verb rather than a command. The history recorder skips it:
   * a read has no target_state, so recording one would fabricate a command that never happened.
   */
  readback?: boolean;
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
  /**
   * The firmware version the device is actually RUNNING, read off the ack topic path.
   * The device publishes on `.../{version}/ack/...`, so this is the device's own report of
   * itself rather than what the catalog believes. Used to settle an OTA: a device that
   * rejects an update as `not-newer` while already running the pending version has in fact
   * completed it.
   */
  version?: string;
}

// A request for a fresh camera frame — raised by ml-router for a pipeline's enrich stage, or by
// the api when a user asks for one from the camera card. digest-service resolves actionId to a
// device (same as ActionRequestedPayload), dispatches the take_picture MQTT command, and arms a
// timeout.
export interface PictureRequestedPayload {
  userId: string;
  actionId: number;
  commandId: string;
  timeoutMs: number;
  /** Who asked for the frame, recorded on the capture's command-history row (F18.6). */
  source?: CommandSource;
  /**
   * Whether the outcome should be published as PICTURE_RESULT. The pipeline needs the frame back
   * on the bus to enrich its context; a user-initiated capture does not — its frame reaches the
   * browser over the socket like any other. Defaults to true, so an omitted field means "deliver".
   * Manual captures set it false rather than pushing a few hundred KB of base64 through the
   * broker for a consumer that will only drop it.
   */
  deliverResult?: boolean;
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

// A firmware update aimed at ONE device (F3.15). Every field below the timestamp is what makes
// that possible, and all of them are required: an OTA used to go out on the fleet-wide
// `ota/updates/<deviceType>` topic, so pressing Update on one device flashed every connected
// device of that type and an offline one missed it with no retry. There is no broadcast to fall
// back to any more, so an unaddressed dispatch is a bug — better rejected by the schema at the
// publisher than published to a topic nothing subscribes to.
export interface OtaDispatchPayload {
  deviceType: string;
  // The TARGET version — what the device compares against its own and downloads.
  version: string;
  url: string;
  releaseNotes?: string;
  timestamp: string;
  userId: number;
  deviceId: number;
  // The version the device is RUNNING, which is the topic segment it subscribes on — NOT
  // `version` above. Firmware builds its command topic from its own compile-time DEVICE_VERSION,
  // so addressing the target would publish to a topic that only exists *after* the update this
  // message is trying to cause.
  firmwareVersion: string;
}

// How long a dispatched OTA is treated as still in flight (device-gateway refuses a second
// dispatch inside it; the api reports the device as updating). A real update settles in
// seconds — the window only has to outlast a slow download, and past it the OTA is declared
// dead so the user can retry a device that went offline mid-update and never came back.
// Shared so the gate and what the UI is told can never disagree.
export const OTA_IN_FLIGHT_MS = 10 * 60_000;

// A sealed device template was released/changed by an admin (api service). device-gateway
// consumes this and re-materializes every already-provisioned device the template matches,
// then pushes a config reload — the "apply migration" for sealed devices.
export interface SealedTemplateAppliedPayload {
  templateId: number;
  timestamp: string;
}

// Incoming OTA release trigger — published by ota-manager/CI, consumed by digest-service which
// validates + audit-logs it. It no longer forwards to OtaDispatchPayload: a release is an
// ANNOUNCEMENT, and the two shapes have genuinely diverged now that a dispatch names one device.
// An announcement names none — ota-manager knows a firmware exists, not who should take it.
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

// A blueprint pipeline decided the current phase is complete (F11.x). Published by ml-router,
// consumed by automation-worker — the single writer of phase columns. It advances exactly ONE
// owner: the setup when `bindingId` is null, otherwise the one pot with that binding id. The target
// phase is not carried — the worker reads the current phase's `advance_to_key` (null ⇒ next).
export interface BlueprintPhaseAdvancePayload {
  userId: string;
  instanceId: number;
  bindingId: number | null;
  source: string;
  /**
   * The pipeline template key that decided this. The consumer re-checks that the owner's phase
   * still names it, exactly as the rule path does — without it the decision cannot be validated on
   * arrival, and an LLM call is long enough for the phase to have moved on in the meantime.
   */
  refKey: string;
}
