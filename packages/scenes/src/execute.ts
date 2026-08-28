import type { Channel } from 'amqplib';
import { db } from '@lattice/prisma-client';
import { publish, RK, type ActionRequestedPayload } from '@lattice/queue';
import { isAutomationLive, isInstanceRunning, resolveParam, resolveSeconds } from '@lattice/params';
import { createLogger } from '@lattice/logger';
import { loadParamContext } from './param-context';

const log = createLogger('scenes:execute');

// Executing a scene (F10.5) — the one implementation, shared by every surface that can press one.
//
// It started as a private method on the API's scenes service, which was correct while the dashboard
// was the only caller. Google Home is the second (F7.12), and this is emphatically not a fan-out
// loop worth copying: it enforces three lifecycle/phase gates, resolves `@param.` / `@phase.`
// references against ONE context loaded up front, and staggers delayed members. A second copy in
// google-home would drift from the dashboard and — the specific failure — dispatch unresolved
// `@param.` strings, which fail the capability's valid_parameters check downstream and reach the
// user as "device did not confirm".
//
// The transport stays with the caller: each service owns its own AMQP channel, so it passes one in
// exactly as it does to its own dispatch helpers.

export interface SceneExecutionResult {
  /** Members actually published. Lower than the member count when a reference resolved to nothing. */
  queued: number;
}

/** Errors carry `statusCode` so the API can answer HTTP and google-home can map a Google error. */
function sceneError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

interface SceneForExecution {
  name: string;
  blueprint_instance_id: number | null;
  blueprint_binding_id: number | null;
  phase_scope: string[];
  currentPhaseKey: string | null;
  lifecycleState: string | null;
  bindingLifecycleState: string | null;
}

async function loadSceneForExecution(userId: number, id: number): Promise<SceneForExecution> {
  const scene = await db.scene.findUnique({
    where: { id },
    select: {
      user_id: true,
      name: true,
      blueprint_instance_id: true,
      blueprint_binding_id: true,
      phase_scope: true,
      blueprint_instance: {
        select: { lifecycle_state: true, current_phase: { select: { key: true } } },
      },
      blueprint_binding: {
        select: { lifecycle_state: true, current_phase: { select: { key: true } } },
      },
    },
  });
  if (!scene) throw sceneError('Scene not found', 404);
  if (scene.user_id !== userId) throw sceneError('Forbidden', 403);
  return {
    name: scene.name,
    blueprint_instance_id: scene.blueprint_instance_id,
    blueprint_binding_id: scene.blueprint_binding_id,
    phase_scope: scene.phase_scope,
    // A per-device scene reads its own device's phase; a setup-wide one reads the setup's.
    currentPhaseKey:
      (scene.blueprint_binding ?? scene.blueprint_instance)?.current_phase?.key ?? null,
    lifecycleState: scene.blueprint_instance?.lifecycle_state ?? null,
    bindingLifecycleState: scene.blueprint_binding?.lifecycle_state ?? null,
  };
}

/**
 * Fire-and-forget fan-out: one ACTION_REQUESTED per member. Returns as soon as the messages are
 * published (the API answers 202) — per-device acks surface through the normal digest → socket
 * state path, not here.
 */
export async function executeScene(
  ch: Channel,
  userId: number,
  sceneId: number,
): Promise<SceneExecutionResult> {
  const {
    name: sceneName,
    blueprint_instance_id,
    blueprint_binding_id,
    phase_scope,
    currentPhaseKey,
    lifecycleState,
    bindingLifecycleState,
  } = await loadSceneForExecution(userId, sceneId);

  // A derived scene is runnable only while its setup is running (F10.13), while the device it
  // belongs to is running if it is a per-device scene (F11.3), and, if it declared phases, while
  // that owner is in one of them (F10). Hand-written scenes belong to no setup and pass all three
  // unconditionally. The messages are separate because the fixes are: start the setup, start the
  // device, versus wait for (or move to) the right phase.
  if (!isInstanceRunning(lifecycleState)) {
    throw sceneError('This scene’s setup is not running', 409);
  }
  if (!isInstanceRunning(bindingLifecycleState)) {
    throw sceneError('The device this scene belongs to is not running', 409);
  }
  if (!isAutomationLive(phase_scope, currentPhaseKey, lifecycleState, bindingLifecycleState)) {
    throw sceneError('This scene is not available in the current phase of its setup', 409);
  }

  const members = await db.sceneMember.findMany({
    where: { scene_id: sceneId },
    orderBy: { sort_order: 'asc' },
  });
  if (members.length === 0) return { queued: 0 };

  // A derived member's target_state may be a stored `@param.` / `@phase.` reference — derive
  // writes those verbatim and resolution belongs to whoever dispatches, exactly as the
  // automation-worker's rule engine does. Unresolved, the reference would travel to
  // digest-service as a literal, fail the capability's valid_parameters check and come back as
  // "device did not confirm" without a command ever reaching the device.
  //
  // Resolved once, up front, rather than per member at send time: a scene is one user gesture,
  // so every member should act on the values as they were when it was pressed — a delayed
  // member must not silently use a different phase's numbers because the phase advanced while
  // it waited.
  const ctx = await loadParamContext(blueprint_instance_id, blueprint_binding_id);

  const send = (actionId: number, value: string, durationSeconds: number | null): void => {
    const payload: ActionRequestedPayload = {
      userId: String(userId),
      actionId,
      value,
      // Held by the device itself, then released — see user_rule_actions.duration_seconds.
      ...(durationSeconds ? { duration: String(durationSeconds) } : {}),
      // Recorded with each command so the history says "Evening scene", not just "on" (F11.12).
      source: { kind: 'scene', refId: sceneId, label: sceneName },
    };
    publish(ch, RK.ACTION_REQUESTED, payload);
  };

  let queued = 0;
  for (const m of members) {
    // Fail closed, like the rule engine: a reference with nothing behind it is dropped with a
    // warning rather than dispatched as raw text.
    const target = resolveParam(m.target_state, ctx);
    if (target === null) {
      log.warn(
        { sceneId, actionId: m.user_device_action_id, target_state: m.target_state },
        'scene member references an unresolvable parameter — not dispatched',
      );
      continue;
    }
    queued++;

    // Both may be references since F11.14, resolved against the same up-front context as the
    // target so a delayed member still acts on the values as they were when the scene was
    // pressed. Unresolvable duration ⇒ hold indefinitely; unresolvable delay ⇒ send now.
    const hold = resolveSeconds(m.duration_seconds, ctx);
    const delay = resolveSeconds(m.delay_seconds, ctx) ?? 0;

    if (delay > 0) {
      // Best-effort in-process stagger; a restart drops pending delayed members.
      setTimeout(() => {
        try {
          send(m.user_device_action_id, target, hold);
        } catch {
          // Channel gone (restart/reconnect) — the scene is fire-and-forget, so drop it
          // rather than crashing the timer callback.
        }
      }, delay * 1000).unref();
    } else {
      send(m.user_device_action_id, target, hold);
    }
  }
  return { queued };
}
