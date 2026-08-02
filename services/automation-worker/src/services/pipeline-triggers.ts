import type { Channel } from 'amqplib';
import type { TelemetryArrivedPayload } from '@lattice/queue';
import { publish, RK } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import {
  EMPTY_PARAM_CONTEXT,
  evaluateThreshold,
  isAutomationLive,
  isErrorReading,
  isTriggerInCooldown,
  resolveParam,
} from '@lattice/params';
import { db, Prisma } from '../db/client';
import { loadParamContexts } from './param-context';

const log = createLogger('automation-worker:pipeline-triggers');

// DeviceCapability.implementation_type values that produce image/camera-frame telemetry rather
// than scalar sensor readings. A camera frame can never satisfy a value threshold, and its value
// is a large base64 blob — skip resolution entirely for these. Mirrors digest-service/src/resolve.
const IMAGE_IMPL_TYPES = new Set(['CameraAction']);

// Match a fresh scalar reading against every enabled sensor_threshold pipeline trigger on that
// action and fire the ones whose threshold + phase scope + cooldown all pass. This is the pipeline
// half of "a scalar state changed → fire automations"; the rule half is rulesEngine.evaluateForUser.
// digest-service owns the authoritative state write for the same telemetry (separate queue); the two
// consume telemetry.arrived independently, so nothing here depends on that write having happened.
export async function matchPipelineTriggers(
  ch: Channel,
  payload: TelemetryArrivedPayload,
): Promise<void> {
  const { userId, deviceId, actionName, value } = payload;

  // A fault envelope is not a value — it can never satisfy a threshold. (evaluateThreshold guards
  // this too, but bailing here avoids the resolve/query round-trips for every fault reading.)
  if (isErrorReading(value)) return;

  const action = await db.userDeviceAction.findFirst({
    where: { user_device_id: parseInt(deviceId, 10), mqtt_action_name: actionName },
    select: { id: true, capability: { select: { implementation_type: true } } },
  });
  // Unknown action, or an image action (no value threshold applies) — nothing to match.
  if (!action || IMAGE_IMPL_TYPES.has(action.capability.implementation_type)) return;

  const triggers = await db.pipelineTrigger.findMany({
    where: {
      pipeline: { enabled: true, user_id: parseInt(userId, 10) },
      trigger_type: 'sensor_threshold',
      user_device_action_id: action.id,
    },
    include: {
      pipeline: {
        // Two gates on a blueprint pipeline's triggers: its setup must be running (F10.13), and
        // its phase_scope must cover the phase that setup is in (F10). Unscoped pipelines (empty
        // scope) fire in every phase — but still only while the setup runs.
        select: {
          id: true,
          user_id: true,
          phase_scope: true,
          blueprint_instance_id: true,
          blueprint_instance: {
            select: { lifecycle_state: true, current_phase: { select: { key: true } } },
          },
        },
      },
    },
  });

  // `threshold_value` is one of the positions a blueprint may fill with a `@param.` / `@phase.`
  // reference, stored verbatim by derive — so it has to be resolved here for the same reason the
  // rule engine resolves its condition thresholds. Unresolved, `evaluateThreshold` parses the
  // reference to NaN, falls back to string equality against the reading, and the trigger simply
  // never fires: no error, no log, a dead automation.
  const contexts = await loadParamContexts(triggers.map((t) => t.pipeline.blueprint_instance_id));

  const now = new Date();
  for (const trigger of triggers) {
    const instanceRow = trigger.pipeline.blueprint_instance;
    const currentPhaseKey = instanceRow?.current_phase?.key ?? null;
    if (
      !isAutomationLive(
        trigger.pipeline.phase_scope,
        currentPhaseKey,
        instanceRow?.lifecycle_state ?? null,
      )
    ) {
      continue;
    }

    const instanceId = trigger.pipeline.blueprint_instance_id;
    const ctx = (instanceId !== null ? contexts.get(instanceId) : undefined) ?? EMPTY_PARAM_CONTEXT;
    // Fail closed, like the rule engine: a reference with nothing behind it must not be compared
    // as raw text.
    const threshold = resolveParam(trigger.threshold_value, ctx);
    if (threshold === null) {
      log.warn(
        { triggerId: trigger.id, threshold_value: trigger.threshold_value },
        'pipeline trigger threshold references an unresolvable parameter — not evaluated',
      );
      continue;
    }
    if (!evaluateThreshold(value, trigger.operator!, threshold)) continue;

    // Per-trigger cooldown, persisted on the trigger row (durable across restarts — unlike the
    // former Valkey key, which reset on restart and could double-fire).
    if (isTriggerInCooldown(trigger.last_fired_at, trigger.min_interval_sec, now)) continue;

    const run = await db.pipelineRun.create({
      data: {
        pipeline_id: trigger.pipeline.id,
        status: 'queued',
        trigger_type: 'sensor_threshold',
        trigger_payload: {
          triggerId: trigger.id,
          actionId: action.id,
          value: String(value),
        } as Prisma.InputJsonValue,
      },
    });

    publish(ch, RK.PIPELINE_TRIGGER, {
      userId: String(trigger.pipeline.user_id),
      pipelineId: String(trigger.pipeline.id),
      runId: run.id,
      value,
      timestamp: now.toISOString(),
    });

    if (trigger.min_interval_sec) {
      await db.pipelineTrigger.update({ where: { id: trigger.id }, data: { last_fired_at: now } });
    }

    log.info(
      { triggerId: trigger.id, pipelineId: trigger.pipeline.id, runId: run.id },
      'pipeline sensor_threshold trigger fired',
    );
  }
}
