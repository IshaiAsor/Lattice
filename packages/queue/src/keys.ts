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
  // A UI client's intent to change an action's state, keyed by UserDeviceAction id.
  // digest resolves it (→ device/version/mqtt name), writes optimistic state + echoes,
  // then publishes ACTION_DISPATCH for the device.
  ACTION_REQUESTED: 'action.requested',
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
  // Best-effort event published by digest when an OTA release passes validation.
  // notification-service (F15) binds q.notification.publish to this key.
  NOTIFICATION_PUBLISH: 'notification.publish',
} as const;

export type RoutingKey = (typeof RK)[keyof typeof RK];

// Dynamic routing key for per-model ML stage queues.
export function mlStageRK(kind: string, name: string, version: string): string {
  return `pipeline.stage.${kind}.${name}.${version}`;
}

export const QUEUES = {
  TELEMETRY_ARRIVED: 'q.telemetry.arrived',
  RULES_EVALUATE: 'q.rules.evaluate',
  PIPELINE_TRIGGER: 'q.pipeline.trigger',
  PIPELINE_CANCEL: 'q.pipeline.cancel',
  PIPELINE_RESULT: 'q.pipeline.result',
  DEVICE_STATE_CHANGED: 'q.device.state.changed',
  ACTION_REQUESTED: 'q.action.requested',
  ACTION_DISPATCH: 'q.action.dispatch',
  ACTION_RESULT: 'q.action.result',
  ACTION_RESULT_GOOGLE_HOME: 'q.action.result.google-home',
  PICTURE_REQUESTED: 'q.picture.requested',
  PICTURE_RESULT: 'q.picture.result',
  PIPELINE_STAGE_SENSOR_DIGEST: 'q.pipeline.stage.sensor_digest',
  PIPELINE_STAGE_COMMAND_EXEC: 'q.pipeline.stage.command_exec',
  PIPELINE_STAGE_DONE: 'q.pipeline.stage.done',
  OTA_INCOMING: 'q.ota.incoming',
  OTA_DISPATCH: 'q.ota.dispatch',
  NOTIFICATION_PUBLISH: 'q.notification.publish',
  DLQ: 'q.dlq',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// Dynamic queue name for per-model ML stage queues.
export function mlStageQueue(kind: string, name: string, version: string): string {
  return `q.pipeline.stage.${kind}.${name}.${version}`;
}
