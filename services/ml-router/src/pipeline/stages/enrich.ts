import type { Channel } from 'amqplib';
import { db, Prisma } from '@lattice/prisma-client';
import { createLogger } from '@lattice/logger';
import { deriveValidParameters } from '@lattice/capability-validation';
import { resolveParam, type ParamContext } from '@lattice/params';
import { env } from '../../config/env.config';
import { requestPicture } from '../picture-capture';
import type { Run } from '../types';
import type { PipelinePlan, PipelineSensorPlan, PipelineStagePlan } from '../registry';

const log = createLogger('ml-router:pipeline:enrich');

export async function runEnrich(
  channel: Channel,
  run: Run,
  stage: Extract<PipelineStagePlan, { type: 'enrich' }>,
): Promise<void> {
  log.info(
    { runId: run.runId, stageId: stage.dbId, isDryRun: run.isDryRun },
    'enrich stage starting',
  );
  const started = new Date();
  let currentState: Record<string, Record<string, unknown>>;
  let sensorDigest: Record<string, Record<string, unknown>>;

  if (run.isDryRun && run.sensorOverrides) {
    // Build both blobs from overrides: map user_device_action_id → value, grouped by group_name / action_name.
    // A dry run is fully simulated — it never reads live current_state or sensor_history.
    currentState = {};
    sensorDigest = {};
    // Image sensors are excluded here — same as the live buildCurrentState/buildSensorDigest
    // path below, which never puts raw frame data in current_state/sensors. The image instead
    // flows through buildImageContext → run.context.image (see the override branch in
    // buildImageContext); dumping it into current_state too would embed the whole base64 frame
    // as literal text in the LLM prompt and blow out the context window.
    for (const sensor of run.plan.sensors) {
      if (sensor.is_image) continue;
      const value = run.sensorOverrides[String(sensor.user_device_action_id)] ?? null;
      if (!currentState[sensor.group_name]) currentState[sensor.group_name] = {};
      currentState[sensor.group_name]![sensor.action_name] = value;
      if (sensor.inject_as_sensor) {
        if (!sensorDigest[sensor.group_name]) sensorDigest[sensor.group_name] = {};
        sensorDigest[sensor.group_name]![sensor.action_name] = {
          value,
          description: sensor.description,
        };
      }
    }
    log.info({ runId: run.runId }, '[dry-run] using simulated sensor values');
  } else {
    currentState = await buildCurrentState(run.plan);
    sensorDigest = await buildSensorDigest(run.plan);
  }

  const expectedRanges = buildExpectedRanges(run.plan);
  if (Object.keys(expectedRanges).length > 0) {
    log.debug(
      { runId: run.runId, phase: run.plan.params.phase?.key ?? null, expectedRanges },
      'enrich: sensor bounds resolved for the current phase',
    );
  }

  const enrichOutput: Record<string, unknown> = {
    current_state: currentState,
    sensors: sensorDigest,
    ...(Object.keys(expectedRanges).length > 0 ? { expected_ranges: expectedRanges } : {}),
    available_actions: await enrichActions(
      run.plan.sensors
        .filter((s) => s.inject_as_action)
        .map((s) => ({
          user_device_action_id: s.user_device_action_id,
          description: s.description,
        })),
    ),
    ...(await buildImageContext(channel, run)),
  };

  run.context = { ...run.context, ...enrichOutput };

  await db.pipelineRunStage.upsert({
    where: { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
    update: {
      status: 'completed',
      output: enrichOutput as Prisma.InputJsonValue,
      completed_at: new Date(),
    },
    create: {
      run_id: run.runId,
      stage_id: stage.dbId,
      status: 'completed',
      output: enrichOutput as Prisma.InputJsonValue,
      started_at: started,
      completed_at: new Date(),
    },
  });
  log.info({ runId: run.runId, stageId: stage.dbId }, 'enrich stage complete');
}

// What "normal" is for each sensor, per group. Bounds have been configurable on a pipeline sensor
// since F5 but were loaded and never used — nothing reached the model. They matter now because a
// blueprint stores them as `@phase.level.min`, so the band the LLM judges against is exactly what
// the current phase says it is, with no pipeline row rewritten on a phase advance.
//
// Resolved per run against the plan's context: a literal bound resolves to itself, an
// unresolvable reference is omitted rather than shown as raw text.
function buildExpectedRanges(plan: PipelinePlan): Record<string, Record<string, unknown>> {
  const ranges: Record<string, Record<string, unknown>> = {};
  for (const sensor of plan.sensors) {
    if (sensor.is_image) continue;
    const min = resolveBound(sensor.min_value, plan.params);
    const max = resolveBound(sensor.max_value, plan.params);
    if (min === null && max === null) continue;
    if (!ranges[sensor.group_name]) ranges[sensor.group_name] = {};
    ranges[sensor.group_name]![sensor.action_name] = {
      ...(min !== null ? { min } : {}),
      ...(max !== null ? { max } : {}),
    };
  }
  return ranges;
}

function resolveBound(value: string | null, params: ParamContext): string | null {
  if (value === null || value === '') return null;
  const resolved = resolveParam(value, params);
  if (resolved === null) {
    log.warn({ bound: value }, 'sensor bound references an unresolvable parameter — omitted');
  }
  return resolved;
}

// Enrich each configured action with trait names (last segment of the Google trait URI,
// e.g. "OnOff") and its accepted-value constraint, so downstream infer stages get concrete
// values/ranges to pick from instead of guessing from the trait name alone. valid_parameters
// is a trait/protocol property (OnOff is always on/off, Brightness is always 0-100), not a
// capability one, so it's derived as the union of every trait the capability declares.
async function enrichActions(
  actions: { user_device_action_id: number; description: string }[],
): Promise<Record<string, unknown>[]> {
  log.trace(
    { actionCount: actions.length },
    'enriching available actions with traits/valid_parameters',
  );
  return Promise.all(
    actions.map(async (a) => {
      const action = await db.userDeviceAction.findUnique({
        where: { id: a.user_device_action_id },
        include: {
          capability: {
            include: {
              traits: {
                include: { google_trait: { select: { value: true, valid_parameters: true } } },
              },
            },
          },
        },
      });
      const traits = (action?.capability.traits ?? []).map(
        (ct) => ct.google_trait.value.split('.').pop() ?? ct.google_trait.value,
      );
      const validParameters = deriveValidParameters(
        (action?.capability.traits ?? []).map((ct) => ct.google_trait.valid_parameters),
      );
      return {
        ...a,
        ...(traits.length > 0 ? { traits } : {}),
        ...(validParameters !== undefined ? { valid_parameters: validParameters } : {}),
      };
    }),
  );
}

// Instantaneous snapshot ("fan is on", "temp is 26C") for every selected item, sensor- or
// action-flagged alike — cheap single-column read of the authoritative UserDeviceAction.current_state
// (kept in sync with sensor_history by digest-service's writeScalarState for both telemetry and
// command acks), no history query needed.
async function buildCurrentState(
  plan: PipelinePlan,
): Promise<Record<string, Record<string, unknown>>> {
  const actionIds = plan.sensors.map((s) => s.user_device_action_id);
  const actions = await db.userDeviceAction.findMany({
    where: { id: { in: actionIds } },
    select: { id: true, current_state: true },
  });
  const stateById = new Map(actions.map((a) => [a.id, a.current_state]));

  const state: Record<string, Record<string, unknown>> = {};
  for (const sensor of plan.sensors) {
    if (!state[sensor.group_name]) state[sensor.group_name] = {};
    state[sensor.group_name]![sensor.action_name] =
      stateById.get(sensor.user_device_action_id) ?? null;
  }
  return state;
}

// A fresh frame for the pipeline's camera item (at most one — enforced at save time in both
// the pipeline editor and services/api). Requests a live on-demand capture rather than trusting
// a passively-cached frame, since schedule/manual triggers have no relationship to a device's
// own telemetry push interval. On timeout, falls back to the most recent frame already
// durably stored in sensor_history, tagged so the run's audit output shows it was stale.
async function buildImageContext(channel: Channel, run: Run): Promise<Record<string, unknown>> {
  const imageSensor = run.plan.sensors.find((s) => s.is_image && s.inject_as_sensor);
  if (!imageSensor) return {};

  if (run.isDryRun) {
    const override = run.sensorOverrides?.[String(imageSensor.user_device_action_id)];
    if (override) return { image: override, image_source: 'live' };
    return await imageFallbackFromHistory(imageSensor);
  }

  const result = await requestPicture(
    channel,
    run.userId,
    imageSensor.user_device_action_id,
    env.pictureRequestTimeoutMs,
  );
  if (result.status === 'ok' && result.image) {
    log.info(
      { runId: run.runId, actionId: imageSensor.user_device_action_id },
      'live camera capture succeeded',
    );
    return { image: result.image, image_source: 'live', image_captured_at: result.capturedAt };
  }

  log.warn(
    { runId: run.runId, actionId: imageSensor.user_device_action_id },
    'live camera capture timed out — falling back to last stored frame',
  );
  return await imageFallbackFromHistory(imageSensor);
}

async function imageFallbackFromHistory(
  sensor: PipelineSensorPlan,
): Promise<Record<string, unknown>> {
  const row = await db.sensorHistory.findFirst({
    where: { user_device_action_id: sensor.user_device_action_id, is_error: false },
    orderBy: { recorded_at: 'desc' },
    select: { value: true, recorded_at: true },
  });
  if (!row) return {};
  return {
    image: row.value,
    image_source: 'fallback_db',
    image_captured_at: row.recorded_at.toISOString(),
  };
}

async function buildSensorDigest(
  plan: PipelinePlan,
): Promise<Record<string, Record<string, unknown>>> {
  const digest: Record<string, Record<string, unknown>> = {};
  // Camera items are excluded here: sensor_history holds base64 frames for them, and nothing
  // downstream (LLM or VLM) consumes a compressed historic digest of raw frames — the VLM stage
  // reads a live/cached frame directly (see prompt.ts). Querying/compressing them here would
  // just be wasted DB reads.
  for (const sensor of plan.sensors.filter((s) => s.inject_as_sensor && !s.is_image)) {
    const since = new Date(Date.now() - sensor.window_minutes * 60 * 1000);
    log.trace(
      {
        pipelineId: plan.pipelineId,
        actionId: sensor.user_device_action_id,
        sinceMinutes: sensor.window_minutes,
      },
      'querying sensor history',
    );
    const rows = await db.sensorHistory.findMany({
      where: {
        user_device_action_id: sensor.user_device_action_id,
        recorded_at: { gte: since },
        is_error: false,
      },
      orderBy: { recorded_at: 'desc' },
      take: sensor.compression === 'last_n' ? (sensor.n ?? 10) : 1000,
      select: { value: true },
    });
    // value is nullable in the schema (null on fault rows); is_error:false already excludes those,
    // so this filter is just to satisfy the non-null string[] contract of compressReadings.
    const values = rows.map((r) => r.value).filter((v): v is string => v !== null);
    const compressed = compressReadings(values, sensor.compression, sensor.n);
    log.trace(
      {
        pipelineId: plan.pipelineId,
        actionId: sensor.user_device_action_id,
        rowCount: rows.length,
        compression: sensor.compression,
      },
      'sensor readings compressed',
    );
    if (!digest[sensor.group_name]) digest[sensor.group_name] = {};
    digest[sensor.group_name]![sensor.action_name] = compressed;
  }
  return digest;
}

function compressReadings(values: string[], compression: string, n: number | null): unknown {
  if (values.length === 0) return null;
  if (compression === 'average') {
    const nums = values.map(Number).filter((v) => !isNaN(v));
    return nums.length > 0 ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : null;
  }
  if (compression === 'last_n') return values.slice(0, n ?? values.length);
  if (compression === 'min_max') {
    const nums = values.map(Number).filter((v) => !isNaN(v));
    if (nums.length === 0) return null;
    return { min: Math.min(...nums), max: Math.max(...nums) };
  }
  if (compression === 'min_max_avg') {
    const nums = values.map(Number).filter((v) => !isNaN(v));
    if (nums.length === 0) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    return { min: Math.min(...nums), max: Math.max(...nums), avg: (sum / nums.length).toFixed(2) };
  }
  // time_series — all values
  return values;
}
