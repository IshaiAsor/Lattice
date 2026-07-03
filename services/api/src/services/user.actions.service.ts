import { deriveValidParameters } from '@lattice/capability-validation';
import { db } from '../db';

// User action management (F2.6). Action *instances* are created by the provisioning /
// device-config flow (device-gateway) with pins configured up front; the api manages
// their lifecycle afterwards: list, rename, (re)group, reorder, delete — owner-scoped.

export interface GoogleTraitView {
  id: number;
  name: string;
  value: string;
}

export interface ActionView {
  id: number;
  deviceId: number;
  deviceName: string;
  name: string;            // action_name (user-facing label)
  mqttName: string;        // mqtt_action_name
  implementation_type: string;
  validParameters: unknown;
  googleTypeId: number | null;
  googleType: { id: number; name: string; value: string } | null;
  googleTraits: GoogleTraitView[];
  defaultTraitId: number | null;
  state: string | null;    // current_state
  online: boolean;
  lastOnlineDate: Date | null;
  sortOrder: number;
  status: string;
  groupId: number | null;
  groupName: string | null;
  telemetryIntervalMs: number | null;
}

class UserActionsService {
  async listUserActions(userId: number): Promise<ActionView[]> {
    const actions = await db.userDeviceAction.findMany({
      where: { user_device: { user_id: userId } },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      include: {
        user_device: true,
        group: true,
        capability: { include: { google_type: true, traits: { include: { google_trait: true } } } },
      },
    });

    return actions.map((a) => {
      const traits = a.capability.traits.map((t) => ({
        id:    t.google_trait.id,
        name:  t.google_trait.name,
        value: t.google_trait.value,
      }));
      // Resolve active trait: user override → catalog default → first trait
      const resolvedDefaultTraitId =
        a.default_trait_id ??
        (a.capability.traits.find((t) => t.is_default)?.google_trait_id ?? null) ??
        (traits[0]?.id ?? null);

      return {
        id:                  a.id,
        deviceId:            a.user_device_id,
        deviceName:          a.user_device.name,
        name:                a.action_name,
        mqttName:            a.mqtt_action_name,
        implementation_type: a.capability.implementation_type,
        validParameters:     deriveValidParameters(a.capability.traits.map((t) => t.google_trait.valid_parameters)),
        googleTypeId:        a.capability.google_type_id,
        googleType:          a.capability.google_type
          ? { id: a.capability.google_type.id, name: a.capability.google_type.name, value: a.capability.google_type.value }
          : null,
        googleTraits:        traits,
        defaultTraitId:      resolvedDefaultTraitId,
        state:               a.current_state,
        online:              a.user_device.online,
        lastOnlineDate:      a.user_device.last_online_date,
        sortOrder:           a.sort_order,
        status:              a.status,
        groupId:             a.group_id,
        groupName:           a.group?.name ?? null,
        telemetryIntervalMs: a.telemetry_interval_ms,
      };
    });
  }

  async updateAction(
    userId: number,
    actionId: number,
    patch: { name?: string; group_id?: number | null; telemetry_interval_ms?: number | null; default_trait_id?: number | null },
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
        action_name:           patch.name?.trim(),
        group_id:              patch.group_id,
        telemetry_interval_ms: patch.telemetry_interval_ms,
        default_trait_id:      patch.default_trait_id,
        updated_at:            new Date(),
      },
    });
  }

  async reorderActions(userId: number, orderedIds: number[]): Promise<void> {
    const owned = new Set((await db.userDeviceAction.findMany({
      where: { user_device: { user_id: userId } },
      select: { id: true },
    })).map((a) => a.id));
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
    await this.ensureOwned(userId, actionId);
    await db.userDeviceAction.delete({ where: { id: actionId } });
  }

  private async ensureOwned(userId: number, actionId: number) {
    const action = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: { capability_id: true, user_device: { select: { user_id: true } } },
    });
    if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 });
    if (action.user_device.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return action;
  }
}

export const userActionsService = new UserActionsService();
