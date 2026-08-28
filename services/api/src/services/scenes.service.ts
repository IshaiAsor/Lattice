import { isAutomationLive, positionalError, positionalText } from '@lattice/params';
import { executeScene } from '@lattice/scenes';
import { db } from '../db';
import { getChannel } from '../queue';

// Scenes (F10.5) — a user-named set of device actions fired on demand. Structurally a
// UserRule without conditions, so this mirrors rules.service.ts. Execution fans out the
// existing ACTION_REQUESTED event (one message per member); digest-service resolves each
// actionId to a device command and streams state back over the user's socket room, so
// there is no scene-specific dispatch or ack path here.
//
// This module owns the CRUD half only. The execution half moved to @lattice/scenes with F7.12,
// when google-home became the second surface that can press a scene.

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
  //
  // The gates, the reference resolution and the stagger live in @lattice/scenes so that pressing
  // the tile and saying "run <scene>" are literally the same code path (F7.12).
  async execute(userId: number, id: number): Promise<{ queued: number }> {
    return executeScene(await getChannel(), userId, id);
  }

  private async ensureOwned(
    userId: number,
    id: number,
  ): Promise<{ blueprint_instance_id: number | null }> {
    const scene = await db.scene.findUnique({
      where: { id },
      select: { user_id: true, blueprint_instance_id: true },
    });
    if (!scene) throw Object.assign(new Error('Scene not found'), { statusCode: 404 });
    if (scene.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return { blueprint_instance_id: scene.blueprint_instance_id };
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
