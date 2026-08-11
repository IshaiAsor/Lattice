import { publish, RK, type ActionRequestedPayload } from '@lattice/queue';
import {
  isAutomationLive,
  isInstanceRunning,
  positionalError,
  positionalText,
  resolveParam,
  resolveSeconds,
} from '@lattice/params';
import { createLogger } from '@lattice/logger';
import { db } from '../db';
import { getChannel } from '../queue';
import { loadParamContext } from './blueprints.param-context';

const log = createLogger('api:scenes');

// Scenes (F10.5) — a user-named set of device actions fired on demand. Structurally a
// UserRule without conditions, so this mirrors rules.service.ts. Execution fans out the
// existing ACTION_REQUESTED event (one message per member); digest-service resolves each
// actionId to a device command and streams state back over the user's socket room, so
// there is no scene-specific dispatch or ack path here.

export interface SceneMemberDto {
  user_device_action_id: number;
  target_state: string;
  sort_order?: number;
  /**
   * A number from the editor or a reference string (F11.14). The UI sends numbers; the wider type
   * is what lets a blueprint-derived scene round-trip without its references being flattened.
   */
  delay_seconds?: number | string | null;
  /** Seconds the DEVICE holds this state before releasing it; null/0 = hold indefinitely. */
  duration_seconds?: number | string | null;
}

export interface CreateSceneDto {
  name: string;
  sort_order?: number;
  members: SceneMemberDto[];
}

export interface SceneMemberView {
  id: number;
  user_device_action_id: number;
  target_state: string;
  sort_order: number;
  delay_seconds: string | null;
  duration_seconds: string | null;
}

export interface SceneView {
  id: number;
  name: string;
  sort_order: number;
  members: SceneMemberView[];
  // Phase scope (F10): the phases this derived scene is offered in (empty = all), and whether the
  // instance is currently in one of them. `in_phase` is always true for hand-written scenes.
  phase_scope: string[];
  in_phase: boolean;
}

function validate(dto: CreateSceneDto): void {
  if (!dto || typeof dto.name !== 'string' || !dto.name.trim()) {
    throw Object.assign(new Error('name is required'), { statusCode: 400 });
  }
  if (!Array.isArray(dto.members) || dto.members.length === 0) {
    throw Object.assign(new Error('at least one member is required'), { statusCode: 400 });
  }
  for (const m of dto.members) {
    if (typeof m?.user_device_action_id !== 'number') {
      throw Object.assign(new Error('member user_device_action_id is required'), {
        statusCode: 400,
      });
    }
    if (typeof m.target_state !== 'string' || !m.target_state.length) {
      throw Object.assign(new Error('member target_state is required'), { statusCode: 400 });
    }
    // A reference is legal here since F11.14, so the check is "is this a usable value" rather than
    // "is this an integer". positionalError accepts any well-formed reference and still rejects the
    // things that would fail closed at dispatch — a negative, or text that is not a number.
    const delayProblem = positionalError(m.delay_seconds, 'seconds');
    if (delayProblem) {
      throw Object.assign(new Error(`member delay_seconds: ${delayProblem}`), { statusCode: 400 });
    }
    const durationProblem = positionalError(m.duration_seconds, 'seconds');
    if (durationProblem) {
      throw Object.assign(new Error(`member duration_seconds: ${durationProblem}`), {
        statusCode: 400,
      });
    }
  }
  const ids = dto.members.map((m) => m.user_device_action_id);
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('duplicate action in scene members'), { statusCode: 400 });
  }
}

function memberCreateData(m: SceneMemberDto, index: number) {
  return {
    user_device_action_id: m.user_device_action_id,
    target_state: m.target_state,
    sort_order: m.sort_order ?? index,
    delay_seconds: positionalText(m.delay_seconds),
    duration_seconds: positionalText(m.duration_seconds),
  };
}

const memberInclude = {
  members: { orderBy: { sort_order: 'asc' as const } },
  // The setup's lifecycle and current phase together drive `in_phase` (F10.13 + F10); absent for
  // hand-written scenes, which are never gated.
  blueprint_instance: {
    select: { lifecycle_state: true, current_phase: { select: { key: true } } },
  },
  // A per-device scene (F11.2) is in its OWN binding's phase and held by its own binding's
  // lifecycle, not the setup's — for a setup-wide scene this is simply absent.
  blueprint_binding: {
    select: { lifecycle_state: true, current_phase: { select: { key: true } } },
  },
};

class ScenesService {
  async list(userId: number): Promise<SceneView[]> {
    const scenes = await db.scene.findMany({
      where: { user_id: userId },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      include: memberInclude,
    });
    return scenes.map((s) => this.toView(s));
  }

  async create(userId: number, dto: CreateSceneDto): Promise<SceneView> {
    validate(dto);
    // Members reference the caller's own actions only — otherwise a scene could command
    // another user's device via the trusted digest path.
    await this.ensureActionsOwned(userId, dto.members);
    await this.ensureNameFree(userId, dto.name.trim(), null);
    const scene = await db.scene.create({
      data: {
        user_id: userId,
        name: dto.name.trim(),
        sort_order: dto.sort_order ?? 0,
        members: { create: dto.members.map(memberCreateData) },
      },
      include: memberInclude,
    });
    return this.toView(scene);
  }

  async update(userId: number, id: number, dto: CreateSceneDto): Promise<SceneView> {
    validate(dto);
    const existing = await this.ensureOwned(userId, id);
    // See rules.service.update — editing a derived scene is drift (F10.6).
    const userModified = existing.blueprint_instance_id !== null ? true : undefined;
    await this.ensureActionsOwned(userId, dto.members);
    await this.ensureNameFree(userId, dto.name.trim(), id);
    // Replace members wholesale so removed rows don't linger.
    const scene = await db.$transaction(async (tx) => {
      await tx.sceneMember.deleteMany({ where: { scene_id: id } });
      return tx.scene.update({
        where: { id },
        data: {
          name: dto.name.trim(),
          sort_order: dto.sort_order ?? 0,
          user_modified: userModified,
          updated_at: new Date(),
          members: { create: dto.members.map(memberCreateData) },
        },
        include: memberInclude,
      });
    });
    return this.toView(scene);
  }

  async remove(userId: number, id: number): Promise<void> {
    await this.ensureOwned(userId, id);
    await db.scene.delete({ where: { id } }); // cascades members
  }

  // Fire-and-forget fan-out: one ACTION_REQUESTED per member. Returns immediately (route
  // answers 202); per-device acks surface through the normal digest → socket state path.
  async execute(userId: number, id: number): Promise<{ queued: number }> {
    const {
      name: sceneName,
      blueprint_instance_id,
      blueprint_binding_id,
      phase_scope,
      currentPhaseKey,
      lifecycleState,
      bindingLifecycleState,
    } = await this.ensureOwned(userId, id);
    // A derived scene is runnable only while its setup is running (F10.13), while the device it
    // belongs to is running if it is a per-device scene (F11.3), and, if it declared phases, while
    // that owner is in one of them (F10). Hand-written scenes belong to no setup and pass all three
    // unconditionally. The messages are separate because the fixes are: start the setup, start the
    // device, versus wait for (or move to) the right phase.
    if (!isInstanceRunning(lifecycleState)) {
      throw Object.assign(new Error('This scene’s setup is not running'), { statusCode: 409 });
    }
    if (!isInstanceRunning(bindingLifecycleState)) {
      throw Object.assign(new Error('The device this scene belongs to is not running'), {
        statusCode: 409,
      });
    }
    if (!isAutomationLive(phase_scope, currentPhaseKey, lifecycleState, bindingLifecycleState)) {
      throw Object.assign(
        new Error('This scene is not available in the current phase of its setup'),
        { statusCode: 409 },
      );
    }
    const members = await db.sceneMember.findMany({
      where: { scene_id: id },
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

    const ch = await getChannel();
    const send = (actionId: number, value: string, durationSeconds: number | null): void => {
      const payload: ActionRequestedPayload = {
        userId: String(userId),
        actionId,
        value,
        // Held by the device itself, then released — see user_rule_actions.duration_seconds.
        ...(durationSeconds ? { duration: String(durationSeconds) } : {}),
        // Recorded with each command so the history says "Evening scene", not just "on" (F11.12).
        source: { kind: 'scene', refId: id, label: sceneName },
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
          { sceneId: id, actionId: m.user_device_action_id, target_state: m.target_state },
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

  private async ensureOwned(
    userId: number,
    id: number,
  ): Promise<{
    name: string;
    blueprint_instance_id: number | null;
    blueprint_binding_id: number | null;
    phase_scope: string[];
    currentPhaseKey: string | null;
    lifecycleState: string | null;
    bindingLifecycleState: string | null;
  }> {
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
    if (!scene) throw Object.assign(new Error('Scene not found'), { statusCode: 404 });
    if (scene.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
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

  // Pre-check the (user_id, name) unique index so a collision is a clean 409 rather than a
  // raw Prisma P2002 surfacing as a 500. `exceptId` skips the row being updated.
  private async ensureNameFree(
    userId: number,
    name: string,
    exceptId: number | null,
  ): Promise<void> {
    const conflict = await db.scene.findFirst({
      where: { user_id: userId, name },
      select: { id: true },
    });
    if (conflict && conflict.id !== exceptId) {
      throw Object.assign(new Error('A scene with this name already exists'), { statusCode: 409 });
    }
  }

  private async ensureActionsOwned(userId: number, members: SceneMemberDto[]): Promise<void> {
    const ids = [...new Set(members.map((m) => m.user_device_action_id))];
    const owned = await db.userDeviceAction.count({
      where: { id: { in: ids }, user_device: { user_id: userId } },
    });
    if (owned !== ids.length) {
      throw Object.assign(new Error('member action not found'), { statusCode: 404 });
    }
  }

  private toView(s: {
    id: number;
    name: string;
    sort_order: number;
    phase_scope: string[];
    blueprint_instance: {
      lifecycle_state: string;
      current_phase: { key: string } | null;
    } | null;
    blueprint_binding: {
      lifecycle_state: string;
      current_phase: { key: string } | null;
    } | null;
    members: {
      id: number;
      user_device_action_id: number;
      target_state: string;
      sort_order: number;
      delay_seconds: string | null;
      duration_seconds: string | null;
    }[];
  }): SceneView {
    const currentPhaseKey =
      (s.blueprint_binding ?? s.blueprint_instance)?.current_phase?.key ?? null;
    const lifecycleState = s.blueprint_instance?.lifecycle_state ?? null;
    const bindingLifecycleState = s.blueprint_binding?.lifecycle_state ?? null;
    return {
      id: s.id,
      name: s.name,
      sort_order: s.sort_order,
      phase_scope: s.phase_scope,
      in_phase: isAutomationLive(
        s.phase_scope,
        currentPhaseKey,
        lifecycleState,
        bindingLifecycleState,
      ),
      members: s.members.map((m) => ({
        id: m.id,
        user_device_action_id: m.user_device_action_id,
        target_state: m.target_state,
        duration_seconds: m.duration_seconds,
        sort_order: m.sort_order,
        delay_seconds: m.delay_seconds,
      })),
    };
  }
}

export const scenesService = new ScenesService();
