import { randomUUID } from 'node:crypto';
import { deriveValidParameters } from '@lattice/capability-validation';
import {
  publish,
  RK,
  type PictureRequestedPayload,
  type ActionReadRequestedPayload,
} from '@lattice/queue';
import { db } from '../db';
import { getChannel } from '../queue';
import { env } from '../config/env.config';
import { ensureNotSealed } from './sealed-templates.service';
import { requestConfigReload } from './config-reload';

// User action management (F2.6). Action *instances* are created by the provisioning /
// device-config flow (device-gateway) with pins configured up front; the api manages
// their lifecycle afterwards: list, rename, (re)group, reorder, delete — owner-scoped.

// DeviceCapability.implementation_type value that produces image/camera-frame telemetry
// (mirrors digest-service/resolve.ts and services/api/.../pipelines.validation.ts).
const IMAGE_IMPL_TYPES = new Set(['CameraAction']);

export interface GoogleTraitView {
  id: number;
  name: string;
  value: string;
}

export interface ActionView {
  id: number;
  deviceId: number;
  deviceName: string;
  name: string; // action_name (user-facing label)
  mqttName: string; // mqtt_action_name
  implementation_type: string;
  validParameters: unknown;
  googleTypeId: number | null;
  googleType: { id: number; name: string; value: string } | null;
  googleTraits: GoogleTraitView[];
  defaultTraitId: number | null;
  state: string | null; // current_state
  // When the platform last had positive confirmation that `state` is what the device holds, and
  // which path confirmed it (F23). Null means never confirmed — the UI shows confidence rather
  // than hiding it, so this is what separates "the pump is off" from "we last heard it was off".
  lastConfirmedAt: Date | null;
  stateSource: string | null;
  online: boolean;
  lastOnlineDate: Date | null;
  sortOrder: number;
  status: string;
  groupId: number | null;
  groupName: string | null;
  // Area (F10.0) of this action's device — powers dashboard sectioning/filtering. The device is
  // the unit that belongs to an area, so every action of a device shares its areaId.
  areaId: number | null;
  areaName: string | null;
  telemetryIntervalMs: number | null;
  // Unified action model (6d): the behaviors this capability supports, and which the user has
  // enabled (with chosen values). The device-config UI renders a toggle per available behavior.
  availableBehaviors: { behavior: string; minIntervalMs: number | null }[];
  enabledBehaviors: {
    behavior: string;
    intervalMs: number | null;
    cameraResolution: string | null;
    cameraTransport: string | null;
  }[];
}

export interface LastFrameView {
  frame: string; // base64 JPEG
  capturedAt: Date;
}

export interface CaptureRequestView {
  commandId: string;
  /** How long the platform will wait for the frame — the client's cue to stop waiting too. */
  timeoutMs: number;
}

export interface StateReadRequestView {
  /**
   * How long the platform will wait for the device to answer. No commandId: digest mints the
   * read's own id, and the answer reaches the browser as an ordinary state update rather than
   * as a correlated reply — deliberately, since a reconcile correction must not look like the
   * echo of somebody's command.
   */
  timeoutMs: number;
}

class UserActionsService {
  async listUserActions(userId: number): Promise<ActionView[]> {
    const actions = await db.userDeviceAction.findMany({
      where: { user_device: { user_id: userId } },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      include: {
        user_device: { include: { area: { select: { id: true, name: true } } } },
        group: true,
        capability: {
          include: {
            google_type: true,
            traits: { include: { google_trait: true } },
            configurations: true,
          },
        },
        configurations: true,
      },
    });

    return actions.map((a) => {
      const traits = a.capability.traits.map((t) => ({
        id: t.google_trait.id,
        name: t.google_trait.name,
        value: t.google_trait.value,
      }));
      // Resolve active trait: user override → catalog default → first trait
      const resolvedDefaultTraitId =
        a.default_trait_id ??
        a.capability.traits.find((t) => t.is_default)?.google_trait_id ??
        traits[0]?.id ??
        null;

      return {
        id: a.id,
        deviceId: a.user_device_id,
        deviceName: a.user_device.name,
        name: a.action_name,
        mqttName: a.mqtt_action_name,
        implementation_type: a.capability.implementation_type,
        validParameters: deriveValidParameters(
          a.capability.traits.map((t) => t.google_trait.valid_parameters),
        ),
        googleTypeId: a.capability.google_type_id,
        googleType: a.capability.google_type
          ? {
              id: a.capability.google_type.id,
              name: a.capability.google_type.name,
              value: a.capability.google_type.value,
            }
          : null,
        googleTraits: traits,
        defaultTraitId: resolvedDefaultTraitId,
        state: a.current_state,
        lastConfirmedAt: a.last_confirmed_at,
        stateSource: a.state_source,
        online: a.user_device.online,
        lastOnlineDate: a.user_device.last_online_date,
        sortOrder: a.sort_order,
        status: a.status,
        groupId: a.group_id,
        groupName: a.group?.name ?? null,
        areaId: a.user_device.area?.id ?? null,
        areaName: a.user_device.area?.name ?? null,
        telemetryIntervalMs: a.telemetry_interval_ms,
        availableBehaviors: a.capability.configurations.map((c) => ({
          behavior: c.behavior,
          minIntervalMs: c.min_interval_ms,
        })),
        enabledBehaviors: a.configurations.map((uc) => ({
          behavior: uc.behavior,
          intervalMs: uc.interval_ms,
          cameraResolution: uc.camera_resolution,
          cameraTransport: uc.camera_transport,
        })),
      };
    });
  }

  async updateAction(
    userId: number,
    actionId: number,
    patch: {
      name?: string;
      group_id?: number | null;
      telemetry_interval_ms?: number | null;
      default_trait_id?: number | null;
    },
  ): Promise<void> {
    const action = await this.ensureOwned(userId, actionId);

    // A target group must belong to the same user.
    if (patch.group_id !== undefined && patch.group_id !== null) {
      const group = await db.userActionGroup.findUnique({
        where: { id: patch.group_id },
        select: { user_id: true },
      });
      if (!group || group.user_id !== userId) {
        throw Object.assign(new Error('Invalid group'), { statusCode: 400 });
      }
    }
    if (patch.name !== undefined && !patch.name.trim()) {
      throw Object.assign(new Error('name cannot be empty'), { statusCode: 400 });
    }
    // Validate that the requested default trait belongs to this action's capability.
    if (patch.default_trait_id !== undefined && patch.default_trait_id !== null) {
      const traitExists = await db.deviceCapabilityTrait.findFirst({
        where: { capability_id: action.capability_id, google_trait_id: patch.default_trait_id },
      });
      if (!traitExists) {
        throw Object.assign(new Error('Trait does not belong to this action'), { statusCode: 400 });
      }
    }

    await db.userDeviceAction.update({
      where: { id: actionId },
      data: {
        action_name: patch.name?.trim(),
        group_id: patch.group_id,
        telemetry_interval_ms: patch.telemetry_interval_ms,
        default_trait_id: patch.default_trait_id,
        updated_at: new Date(),
      },
    });

    // Only the interval reaches the device — name, group and default trait are platform-side, and
    // restarting a device because the user renamed a tile would be a poor trade.
    if (patch.telemetry_interval_ms !== undefined) {
      requestConfigReload(userId, action.user_device_id);
    }
  }

  // Replace the action's enabled behaviors (unified action model). Declarative: the passed set
  // becomes the full set — behaviors absent from it are disabled. Each is validated against the
  // capability's catalog rows (capability_configurations) so a user can't enable a behavior the
  // firmware doesn't support, nor pick an interval below the hardware floor.
  async setActionBehaviors(
    userId: number,
    actionId: number,
    behaviors: {
      behavior: string;
      interval_ms?: number | null;
      camera_resolution?: string | null;
      camera_transport?: string | null;
    }[],
  ): Promise<void> {
    const action = await this.ensureOwned(userId, actionId);
    // Behaviors are part of the sealed template's entry config — a user edit would be reverted
    // on the next template apply. Renaming/grouping (updateAction) stays allowed.
    ensureNotSealed(action.isSealed);

    const catalog = await db.capabilityConfiguration.findMany({
      where: { capability_id: action.capability_id },
    });
    const byBehavior = new Map(catalog.map((c) => [c.behavior, c]));

    for (const b of behaviors) {
      const cc = byBehavior.get(b.behavior);
      if (!cc) {
        throw Object.assign(
          new Error(`behavior '${b.behavior}' not supported by this capability`),
          {
            statusCode: 400,
          },
        );
      }
      if (
        b.behavior === 'interval' &&
        b.interval_ms != null &&
        cc.min_interval_ms != null &&
        b.interval_ms < cc.min_interval_ms
      ) {
        throw Object.assign(
          new Error(
            `interval_ms ${b.interval_ms} is below the capability floor ${cc.min_interval_ms}`,
          ),
          { statusCode: 400 },
        );
      }
    }

    const wanted = behaviors.map((b) => b.behavior);

    await db.$transaction(async (tx) => {
      await tx.userActionConfiguration.deleteMany({
        where: { user_device_action_id: actionId, behavior: { notIn: wanted } },
      });
      for (const b of behaviors) {
        const cc = byBehavior.get(b.behavior)!;
        const values = {
          interval_ms: b.interval_ms ?? null,
          camera_resolution: b.camera_resolution ?? null,
          camera_transport: b.camera_transport ?? null,
        };
        await tx.userActionConfiguration.upsert({
          where: {
            user_device_action_id_behavior: {
              user_device_action_id: actionId,
              behavior: b.behavior,
            },
          },
          create: {
            user_device_action_id: actionId,
            capability_configuration_id: cc.id,
            behavior: b.behavior,
            ...values,
          },
          update: { capability_configuration_id: cc.id, ...values, updated_at: new Date() },
        });
      }
    });

    // Behaviors gate the action's surfaces on the device itself (whether it commands, reads on a
    // cycle, or answers on demand) and are served in its config — so they take effect on reload.
    requestConfigReload(userId, action.user_device_id);
  }

  async reorderActions(userId: number, orderedIds: number[]): Promise<void> {
    const owned = new Set(
      (
        await db.userDeviceAction.findMany({
          where: { user_device: { user_id: userId } },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    if (orderedIds.some((id) => !owned.has(id))) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    await db.$transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx.userDeviceAction.update({ where: { id }, data: { sort_order: index } });
      }
    });
  }

  async deleteAction(userId: number, actionId: number): Promise<void> {
    const action = await this.ensureOwned(userId, actionId);
    ensureNotSealed(action.isSealed);
    await db.userDeviceAction.delete({ where: { id: actionId } });

    // Until it reloads, the device keeps driving a pin for an action the platform no longer has.
    requestConfigReload(userId, action.user_device_id);
  }

  // Latest camera frame for on-load display (F6.7). Frames are pushed live over the socket
  // (action_state_update keyed by actionId), but current_state is deliberately NOT written for
  // images — per-frame base64 would churn the DB — so a freshly loaded camera card stays blank
  // until the next live frame arrives (noticeable for on-demand captures). This serves the most
  // recent frame from camera_frame_history, the authoritative per-action image store, so the card
  // paints immediately. Read-only: no per-frame DB writes are reintroduced. (The digest
  // camera_frame:{deviceId} Valkey cache is intentionally not used here — it's keyed per device,
  // so it's lossy for a device with multiple cameras, whereas the history table is per action.)
  async getLastFrame(userId: number, actionId: number): Promise<LastFrameView | null> {
    const action = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: {
        capability: { select: { implementation_type: true } },
        user_device: { select: { user_id: true } },
      },
    });
    if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 });
    if (action.user_device.user_id !== userId)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    if (!IMAGE_IMPL_TYPES.has(action.capability.implementation_type))
      throw Object.assign(new Error('Action is not a camera action'), { statusCode: 400 });

    // Frames moved out of sensor_history at F18.1; fault rows for a camera action stayed behind
    // (they carry value NULL), which is why this no longer needs an is_error filter — the table
    // only holds frames.
    const latest = await db.cameraFrameHistory.findFirst({
      where: { user_device_action_id: actionId },
      orderBy: { recorded_at: 'desc' },
      select: { value: true, recorded_at: true },
    });
    if (!latest?.value) return null;
    return { frame: latest.value, capturedAt: latest.recorded_at };
  }

  /**
   * Ask a camera for a frame right now.
   *
   * Nothing is returned but the correlation id: the frame comes back the way every frame does —
   * stored to history, then pushed to the browser as an `action_state_update` — so the camera card
   * needs no special delivery path, only something to stop waiting on. `timeoutMs` is that
   * something, handed back so the client gives up at the same moment the server does.
   *
   * Offline is rejected here rather than dispatched: the request would be guaranteed to time out,
   * and "the device is offline" is a better answer than fifteen seconds of spinner.
   */
  async requestCapture(userId: number, actionId: number): Promise<CaptureRequestView> {
    const action = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: {
        capability: { select: { implementation_type: true } },
        user_device: { select: { user_id: true, online: true } },
      },
    });
    if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 });
    if (action.user_device.user_id !== userId)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    if (!IMAGE_IMPL_TYPES.has(action.capability.implementation_type))
      throw Object.assign(new Error('Action is not a camera action'), { statusCode: 400 });
    if (!action.user_device.online)
      throw Object.assign(new Error('Device is offline'), { statusCode: 409 });

    const commandId = randomUUID();
    const timeoutMs = env.pictureAckTimeoutMs;
    const payload: PictureRequestedPayload = {
      userId: String(userId),
      actionId,
      commandId,
      timeoutMs,
      // A person pressed the button — the same source a dashboard command carries.
      source: { kind: 'manual' },
      // The frame's only consumer is this user's browser, and it is already on its way there over
      // the socket. Publishing it as PICTURE_RESULT too would push a few hundred KB of base64
      // through the broker for ml-router to look up, not recognise, and drop.
      deliverResult: false,
    };
    publish(await getChannel(), RK.PICTURE_REQUESTED, payload);
    return { commandId, timeoutMs };
  }

  /**
   * Ask a device what state an action is actually in, right now (F23.6).
   *
   * The counterpart to a command: it changes nothing and returns nothing but something to wait
   * on. The device answers on the ack topic, digest compares that against what the row claims,
   * and either refreshes the confirmation stamp or corrects the state — either way the browser
   * hears about it as an ordinary `action_state_update`.
   *
   * Offline is rejected rather than dispatched, for the same reason a capture is: the read would
   * be guaranteed to time out, and saying so immediately is the better answer.
   */
  async requestStateRead(userId: number, actionId: number): Promise<StateReadRequestView> {
    const action = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: {
        user_device_id: true,
        capability: { select: { mqtt_action_type: true } },
        user_device: { select: { user_id: true, online: true } },
      },
    });
    if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 });
    if (action.user_device.user_id !== userId)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    // A telemetry action has its own on-demand path (the camera's capture button, a cyclic
    // reading); the read verb answers from NVS state, which only a command action has.
    if (action.capability.mqtt_action_type !== 'command')
      throw Object.assign(new Error('Action is not a command action'), { statusCode: 400 });
    if (!action.user_device.online)
      throw Object.assign(new Error('Device is offline'), { statusCode: 409 });

    const payload: ActionReadRequestedPayload = {
      userId: String(userId),
      deviceId: String(action.user_device_id),
      actionId,
      reason: 'manual',
    };
    publish(await getChannel(), RK.ACTION_READ_REQUESTED, payload);
    return { timeoutMs: env.actionReadTimeoutMs };
  }

  private async ensureOwned(userId: number, actionId: number) {
    const action = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: {
        capability_id: true,
        // Carried so config-affecting edits can ask the owning device to reload (F3.11).
        user_device_id: true,
        user_device: { select: { user_id: true, device: { select: { is_sealed: true } } } },
      },
    });
    if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 });
    if (action.user_device.user_id !== userId)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return { ...action, isSealed: action.user_device.device.is_sealed };
  }
}

export const userActionsService = new UserActionsService();
