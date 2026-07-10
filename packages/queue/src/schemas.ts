// Runtime event contract — one zod schema per RK payload, mirroring the interfaces in
// ./types.ts. `publish()` validates against these outside production, so an off-contract
// publish fails loudly in dev/test instead of corrupting a downstream consumer.
//
// GUARDRAIL (docs/TESTING.md): any change to a payload interface in ./types.ts updates its
// schema here AND the canonical example in tests/unit/queue-contracts.test.ts, same change.
// Unknown extra keys are allowed (forward compatibility); missing/mistyped known keys fail.

import { z } from 'zod';
import { RK } from './keys';

export const telemetryArrivedSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
  actionName: z.string(),
  value: z.unknown(),
  timestamp: z.string(),
  commandId: z.string().optional(),
});

export const rulesEvaluateSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
  actionName: z.string(),
  value: z.unknown(),
  timestamp: z.string(),
});

export const pipelineTriggerSchema = z.object({
  userId: z.string(),
  pipelineId: z.string(),
  runId: z.number(),
  deviceId: z.string().optional(),
  actionName: z.string().optional(),
  value: z.unknown().optional(),
  timestamp: z.string().optional(),
  isDryRun: z.boolean().optional(),
  sensorOverrides: z.record(z.string()).optional(),
});

export const pipelineResultSchema = z.object({
  userId: z.string(),
  pipelineId: z.string(),
  pipelineRunId: z.string(),
  status: z.enum(['completed', 'failed']),
  error: z.string().optional(),
});

export const pipelineCancelSchema = z.object({
  userId: z.string(),
  pipelineId: z.string(),
  runId: z.number(),
});

export const deviceStateChangedSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
  actionName: z.string(),
  state: z.unknown(),
  timestamp: z.string(),
  version: z.string().optional(),
});

export const deviceHeartbeatSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
  version: z.string(),
  timestamp: z.string(),
  uptimeMs: z.number().optional(),
  freeHeap: z.number().optional(),
  rssi: z.number().optional(),
});

export const actionRequestedSchema = z.object({
  userId: z.string(),
  actionId: z.number(),
  value: z.unknown(),
  duration: z.string().optional(),
});

export const actionDispatchSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
  actionName: z.string(),
  command: z.unknown(),
  commandId: z.string().optional(),
  firmwareVersion: z.string().optional(),
});

export const actionResultSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
  actionName: z.string(),
  commandId: z.string().optional(),
  status: z.enum(['ok', 'error']),
  value: z.unknown().optional(),
  timestamp: z.string(),
});

export const pictureRequestedSchema = z.object({
  userId: z.string(),
  actionId: z.number(),
  commandId: z.string(),
  timeoutMs: z.number(),
});

export const pictureResultSchema = z.object({
  commandId: z.string(),
  status: z.enum(['ok', 'timeout']),
  image: z.string().optional(),
  capturedAt: z.string().optional(),
});

export const pipelineStageSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
  pipelineId: z.string(),
  pipelineRunId: z.string(),
  stageId: z.string(),
  stageName: z.string(),
  stageKind: z.string(),
  context: z.record(z.unknown()),
});

export const pipelineStageDoneSchema = z.object({
  pipelineRunId: z.string(),
  stageId: z.string(),
  status: z.enum(['completed', 'failed']),
  output: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

export const otaDispatchSchema = z.object({
  deviceType: z.string(),
  version: z.string(),
  url: z.string(),
  releaseNotes: z.string().optional(),
  timestamp: z.string(),
});

// Shape mirrors otaDispatchSchema for now but kept separate as it may diverge (CI metadata).
export const otaIncomingSchema = otaDispatchSchema;

export const notificationPublishSchema = z.object({
  type: z.literal('ota_available'),
  deviceType: z.string(),
  version: z.string(),
});

export const notificationSendSchema = z.object({
  userId: z.string(),
  eventType: z.string(),
  data: z.record(z.string(), z.unknown()),
  dedupeKey: z.string().optional(),
  channels: z.array(z.string()).optional(),
});

// Routing key → schema. Dynamic ML-stage routing keys (mlStageRK) intentionally have no
// entry here — their payload is pipelineStageSchema but the key is per-model; publish()
// skips validation for unknown keys.
export const EVENT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  [RK.TELEMETRY_ARRIVED]: telemetryArrivedSchema,
  [RK.RULES_EVALUATE]: rulesEvaluateSchema,
  [RK.PIPELINE_TRIGGER]: pipelineTriggerSchema,
  [RK.PIPELINE_CANCEL]: pipelineCancelSchema,
  [RK.PIPELINE_RESULT]: pipelineResultSchema,
  [RK.DEVICE_STATE_CHANGED]: deviceStateChangedSchema,
  [RK.DEVICE_HEARTBEAT]: deviceHeartbeatSchema,
  [RK.ACTION_REQUESTED]: actionRequestedSchema,
  [RK.ACTION_DISPATCH]: actionDispatchSchema,
  [RK.ACTION_RESULT]: actionResultSchema,
  [RK.PICTURE_REQUESTED]: pictureRequestedSchema,
  [RK.PICTURE_RESULT]: pictureResultSchema,
  [RK.PIPELINE_STAGE_SENSOR_DIGEST]: pipelineStageSchema,
  [RK.PIPELINE_STAGE_COMMAND_EXEC]: pipelineStageSchema,
  [RK.PIPELINE_STAGE_DONE]: pipelineStageDoneSchema,
  [RK.OTA_INCOMING]: otaIncomingSchema,
  [RK.OTA_DISPATCH]: otaDispatchSchema,
  [RK.NOTIFICATION_PUBLISH]: notificationPublishSchema,
  [RK.NOTIFICATION_SEND]: notificationSendSchema,
};
