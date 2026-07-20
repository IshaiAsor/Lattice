import { publish, RK, type ActionRequestedPayload } from '@lattice/queue';
import { db } from '../db';
import { getChannel } from '../queue';

// Scenes (F10.5) — a user-named set of device actions fired on demand. Structurally a
// UserRule without conditions, so this mirrors rules.service.ts. Execution fans out the
// existing ACTION_REQUESTED event (one message per member); digest-service resolves each
// actionId to a device command and streams state back over the user's socket room, so
// there is no scene-specific dispatch or ack path here.

export interface SceneMemberDto {
  user_device_action_id: number;
  target_state: string;
  sort_order?: number;
  delay_seconds?: number;
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
  delay_seconds: number;
}

export interface SceneView {
  id: number;
  name: string;
  sort_order: number;
  members: SceneMemberView[];
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
    if (
      m.delay_seconds !== undefined &&
      (!Number.isInteger(m.delay_seconds) || m.delay_seconds < 0)
    ) {
      throw Object.assign(new Error('member delay_seconds must be a non-negative integer'), {
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
    delay_seconds: m.delay_seconds ?? 0,
  };
}

const memberInclude = { members: { orderBy: { sort_order: 'asc' as const } } };

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
    await this.ensureOwned(userId, id);
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
    await this.ensureOwned(userId, id);
    const members = await db.sceneMember.findMany({
      where: { scene_id: id },
      orderBy: { sort_order: 'asc' },
    });
    if (members.length === 0) return { queued: 0 };

    const ch = await getChannel();
    const send = (actionId: number, value: string): void => {
      const payload: ActionRequestedPayload = { userId: String(userId), actionId, value };
      publish(ch, RK.ACTION_REQUESTED, payload);
    };

    for (const m of members) {
      if (m.delay_seconds > 0) {
        // Best-effort in-process stagger; a restart drops pending delayed members.
        setTimeout(() => {
          try {
            send(m.user_device_action_id, m.target_state);
          } catch {
            // Channel gone (restart/reconnect) — the scene is fire-and-forget, so drop it
            // rather than crashing the timer callback.
          }
        }, m.delay_seconds * 1000).unref();
      } else {
        send(m.user_device_action_id, m.target_state);
      }
    }
    return { queued: members.length };
  }

  private async ensureOwned(userId: number, id: number): Promise<void> {
    const scene = await db.scene.findUnique({ where: { id }, select: { user_id: true } });
    if (!scene) throw Object.assign(new Error('Scene not found'), { statusCode: 404 });
    if (scene.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
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
    members: {
      id: number;
      user_device_action_id: number;
      target_state: string;
      sort_order: number;
      delay_seconds: number;
    }[];
  }): SceneView {
    return {
      id: s.id,
      name: s.name,
      sort_order: s.sort_order,
      members: s.members.map((m) => ({
        id: m.id,
        user_device_action_id: m.user_device_action_id,
        target_state: m.target_state,
        sort_order: m.sort_order,
        delay_seconds: m.delay_seconds,
      })),
    };
  }
}

export const scenesService = new ScenesService();
