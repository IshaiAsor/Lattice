import type { Channel } from 'amqplib';
import type { TelemetryArrivedPayload } from '@lattice/queue';
import { publish, RK } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import {
  EMPTY_PARAM_CONTEXT,
  evaluateThreshold,
  firedThisMinute,
  isAutomationLive,
  isErrorReading,
  isTriggerInCooldown,
  matchesSchedule,
  resolveClock,
  resolveParam,
} from '@lattice/params';
import { db, Prisma } from '../db/client';
import { loadParamContexts, contextKey } from './param-context';

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
        // Three gates on a blueprint pipeline's triggers: its setup must be running (F10.13), the
        // device it belongs to must be running when it is a per-device pipeline (F11.3), and its
        // phase_scope must cover the phase that owner is in (F10). Unscoped pipelines (empty scope)
        // fire in every phase — but still only while their owner runs.
        select: {
          id: true,
          user_id: true,
          phase_scope: true,
          blueprint_instance_id: true,
          blueprint_binding_id: true,
        },
      },
    },
  });

  // `threshold_value` is one of the positions a blueprint may fill with a `@param.` / `@phase.`
  // reference, stored verbatim by derive — so it has to be resolved here for the same reason the
  // rule engine resolves its condition thresholds. Unresolved, `evaluateThreshold` parses the
  // reference to NaN, falls back to string equality against the reading, and the trigger simply
  // never fires: no error, no log, a dead automation.
  const contexts = await loadParamContexts(triggers.map((t) => t.pipeline));

  const now = new Date();
  for (const trigger of triggers) {
    // The context carries the phase and both lifecycles, so the gate and the resolved threshold
    // come from one read of one owner — they cannot disagree about which phase they describe.
    const ctx =
      contexts.get(
        contextKey(trigger.pipeline.blueprint_instance_id, trigger.pipeline.blueprint_binding_id),
      ) ?? EMPTY_PARAM_CONTEXT;
    if (
      !isAutomationLive(
        trigger.pipeline.phase_scope,
        ctx.phase?.key ?? null,
        ctx.lifecycle,
        ctx.bindingLifecycle,
      )
    ) {
      continue;
    }

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

// ─── Schedule triggers ──────────────────────────────────────────────────────────────────────────
//
// The half that never existed. `schedule_cron` was accepted at publish, persisted, derived and
// reconciled — and nothing ever read it, so a pipeline whose only trigger was a schedule simply
// never ran. This is the scan that makes one fire, on the same 10s cron the rule engine uses and
// through the same gates: the setup running, the device running, the phase in scope, the cooldown
// expired.
//
// Minute-granular, like a rule's schedule — which means the 10s tick sees each matching minute six
// times. `min_interval_sec` is a user-chosen rate limit and may be unset, so it cannot be what
// stops the repeats; `last_fired_at` falling in the same clock minute is. That check is exact
// rather than an elapsed-seconds floor: a one-minute interval puts consecutive firings 55–65s
// apart depending on where in the minute the tick lands, and a 60s floor would drop every other one.
export async function fireDueScheduleTriggers(ch: Channel): Promise<number> {
  const now = new Date();
  const triggers = await db.pipelineTrigger.findMany({
    where: {
      trigger_type: 'schedule',
      schedule_time: { not: null },
      pipeline: { enabled: true },
    },
    include: {
      pipeline: {
        select: {
          id: true,
          user_id: true,
          phase_scope: true,
          blueprint_instance_id: true,
          blueprint_binding_id: true,
          // The owner's zone — a schedule says what their clock reads, and this process runs in
          // UTC. Null (never chosen) keeps the server zone, which is what these did before.
          user: { select: { timezone: true } },
        },
      },
    },
  });
  if (triggers.length === 0) return 0;

  const contexts = await loadParamContexts(triggers.map((t) => t.pipeline));
  let fired = 0;

  for (const trigger of triggers) {
    // Resolved before the match, not after: since F11.14 either clock may be a reference, and a
    // reference can only be read against this pipeline's own context. The gate below still runs
    // after — a trigger whose time matches but whose phase is out of scope must not fire.
    const ctx =
      contexts.get(
        contextKey(trigger.pipeline.blueprint_instance_id, trigger.pipeline.blueprint_binding_id),
      ) ?? EMPTY_PARAM_CONTEXT;

    const time = resolveClock(trigger.schedule_time, ctx);
    if (time === null) {
      // Only worth saying when the author wrote a reference; a null time cannot reach here at all
      // (the query filters it out), so this is always an unresolvable or malformed value.
      log.warn(
        { triggerId: trigger.id, schedule_time: trigger.schedule_time },
        'pipeline schedule trigger time unresolvable — not fired',
      );
      continue;
    }
    if (
      !matchesSchedule(
        {
          time,
          until: resolveClock(trigger.schedule_until, ctx),
          everyMinutes: trigger.schedule_every_minutes,
          days: trigger.schedule_days,
        },
        now,
        trigger.pipeline.user.timezone,
      )
    ) {
      continue;
    }

    if (
      !isAutomationLive(
        trigger.pipeline.phase_scope,
        ctx.phase?.key ?? null,
        ctx.lifecycle,
        ctx.bindingLifecycle,
      )
    ) {
      continue;
    }

    if (firedThisMinute(trigger.last_fired_at, now)) continue;
    if (isTriggerInCooldown(trigger.last_fired_at, trigger.min_interval_sec, now)) continue;

    // Claim the minute before creating the run, and let the database arbitrate: the `where` matches
    // only while `last_fired_at` is still older than the minute we are in, so of two passes over the
    // same trigger exactly one wins. One scan cannot race itself, but two worker replicas can — and
    // the rule engine's equivalent race was observed live, dispatching one firing twice.
    const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const claimed = await db.pipelineTrigger.updateMany({
      where: {
        id: trigger.id,
        OR: [{ last_fired_at: null }, { last_fired_at: { lt: minuteStart } }],
      },
      data: { last_fired_at: now },
    });
    if (claimed.count === 0) continue;

    const run = await db.pipelineRun.create({
      data: {
        pipeline_id: trigger.pipeline.id,
        status: 'queued',
        trigger_type: 'schedule',
        trigger_payload: {
          triggerId: trigger.id,
          at: now.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    publish(ch, RK.PIPELINE_TRIGGER, {
      userId: String(trigger.pipeline.user_id),
      pipelineId: String(trigger.pipeline.id),
      runId: run.id,
      value: now.toISOString(),
      timestamp: now.toISOString(),
    });

    fired++;

    log.info(
      { triggerId: trigger.id, pipelineId: trigger.pipeline.id, runId: run.id },
      'pipeline schedule trigger fired',
    );
  }
  return fired;
}
