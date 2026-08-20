// Routing keys + queue names — the event contract's address space. Kept in their own module
// (not index.ts) so schemas.ts can import them without a circular dependency.

// Static routing keys — no userId anywhere; userId lives in the payload.
export const RK = {
  TELEMETRY_ARRIVED: 'telemetry.arrived',
  RULES_EVALUATE: 'rules.evaluate',
  PIPELINE_TRIGGER: 'pipeline.trigger',
  PIPELINE_CANCEL: 'pipeline.cancel',
  PIPELINE_RESULT: 'pipeline.result',
  DEVICE_STATE_CHANGED: 'device.state.changed',
  // A device's periodic liveness ping (independent of telemetry). mqtt-service forwards it;
  // digest refreshes a short-TTL last-seen cache key so "alive but quiet" ≠ "gone".
  DEVICE_HEARTBEAT: 'device.heartbeat',
  // A UI client's intent to change an action's state, keyed by UserDeviceAction id.
  // digest resolves it (→ device/version/mqtt name), writes optimistic state + echoes,
  // then publishes ACTION_DISPATCH for the device.
  ACTION_REQUESTED: 'action.requested',
  // A request to ask a device what state it is ACTUALLY in, rather than tell it to change.
  // digest resolves it and dispatches the firmware's reserved `read` verb; the device answers
  // on the ack topic and the reply corrects current_state if it diverged (F23). Never creates
  // a device_commands row — a read has no target_state, so it is not a command.
  ACTION_READ_REQUESTED: 'action.read.requested',
  ACTION_DISPATCH: 'action.dispatch',
  // A device's ack that it executed (or rejected) a command. digest writes the
  // authoritative current_state on success and resolves the in-flight pending request.
  ACTION_RESULT: 'action.result',
  // ml-router's request for a fresh camera frame (not a cached/periodic one), and digest's
  // correlated response — same request/response shape as ACTION_REQUESTED/ACTION_RESULT,
  // but for camera captures triggered by a pipeline's enrich stage.
  PICTURE_REQUESTED: 'picture.requested',
  PICTURE_RESULT: 'picture.result',
  PIPELINE_STAGE_SENSOR_DIGEST: 'pipeline.stage.sensor_digest',
  PIPELINE_STAGE_COMMAND_EXEC: 'pipeline.stage.command_exec',
  PIPELINE_STAGE_DONE: 'pipeline.stage.done.v1',
  OTA_INCOMING: 'ota.incoming',
  OTA_DISPATCH: 'ota.dispatch',
  // A sealed device template was released/changed by an admin. device-gateway re-materializes
  // every already-provisioned device the template matches (rebuild actions/pins/behaviors) and
  // pushes a config reload — the "apply migration" for sealed devices.
  SEALED_TEMPLATE_APPLIED: 'sealed.template.applied',
  // Best-effort event published by digest when an OTA release passes validation.
  // notification-service (F15) binds q.notification.publish to this key.
  NOTIFICATION_PUBLISH: 'notification.publish',
  // A user-targeted notification request. Any service that already knows the userId
  // (emergency, rule-fire, email-verification) publishes this directly; notification-service
  // resolves prefs and fans out to the enabled channels. Device-scoped events that still need
  // owner resolution use NOTIFICATION_PUBLISH instead.
  NOTIFICATION_SEND: 'notification.send',
  // A blueprint pipeline's model decided the current phase is complete (F11.x). ml-router publishes
  // it; automation-worker (the single writer of phase columns) consumes it and advances the setup
  // or the pot named by `bindingId`. Rule-driven advances stay in-process in automation-worker and
  // never touch this key.
  BLUEPRINT_PHASE_ADVANCE: 'blueprint.phase.advance',
} as const;

export type RoutingKey = (typeof RK)[keyof typeof RK];

// Dynamic routing key for per-model ML stage queues.
export function mlStageRK(kind: string, name: string, version: string): string {
  return `pipeline.stage.${kind}.${name}.${version}`;
}

export const QUEUES = {
  TELEMETRY_ARRIVED: 'q.telemetry.arrived',
  // Second consumer of telemetry.arrived: automation-worker's pipeline sensor-threshold matcher.
  // The `iot` topic exchange copies each telemetry message to both this queue and
  // TELEMETRY_ARRIVED, so digest (state) and automation-worker (triggers) consume independently.
  TELEMETRY_ARRIVED_AUTOMATION: 'q.telemetry.arrived.automation',
  RULES_EVALUATE: 'q.rules.evaluate',
  PIPELINE_TRIGGER: 'q.pipeline.trigger',
  PIPELINE_CANCEL: 'q.pipeline.cancel',
  PIPELINE_RESULT: 'q.pipeline.result',
  DEVICE_STATE_CHANGED: 'q.device.state.changed',
  DEVICE_HEARTBEAT: 'q.device.heartbeat',
  ACTION_REQUESTED: 'q.action.requested',
  ACTION_READ_REQUESTED: 'q.action.read.requested',
  ACTION_DISPATCH: 'q.action.dispatch',
  // Second consumer of action.dispatch: digest-service's command recorder. Dispatch is the single
  // point every command passes through — the UI's, a rule's, a scene's, a pipeline's — so one queue
  // here records all of them without each publisher having to remember to.
  ACTION_DISPATCH_HISTORY: 'q.action.dispatch.history',
  ACTION_RESULT: 'q.action.result',
  ACTION_RESULT_GOOGLE_HOME: 'q.action.result.google-home',
  PICTURE_REQUESTED: 'q.picture.requested',
  PICTURE_RESULT: 'q.picture.result',
  PIPELINE_STAGE_SENSOR_DIGEST: 'q.pipeline.stage.sensor_digest',
  PIPELINE_STAGE_COMMAND_EXEC: 'q.pipeline.stage.command_exec',
  PIPELINE_STAGE_DONE: 'q.pipeline.stage.done',
  OTA_INCOMING: 'q.ota.incoming',
  OTA_DISPATCH: 'q.ota.dispatch',
  SEALED_TEMPLATE_APPLIED: 'q.sealed.template.applied',
  NOTIFICATION_PUBLISH: 'q.notification.publish',
  NOTIFICATION_SEND: 'q.notification.send',
  BLUEPRINT_PHASE_ADVANCE: 'q.blueprint.phase.advance',
  DLQ: 'q.dlq',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// Dynamic queue name for per-model ML stage queues.
export function mlStageQueue(kind: string, name: string, version: string): string {
  return `q.pipeline.stage.${kind}.${name}.${version}`;
}
