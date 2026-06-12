import { db } from '@lattice/prisma-client';
import type { UserDevice, UserAction, UserActionDef, UserDeviceModel } from '@lattice/prisma-client';
import type { CapabilityReport } from '../services/provisioning.service';

export type DeviceWithModel = UserDevice & { device_model: UserDeviceModel };
export type ActionWithDef = UserAction & { action_def: UserActionDef };

class DeviceGatewayRepository {
  // ─── Device resolution ────────────────────────────────────────────────────

  async getDeviceByMacId(macId: string): Promise<DeviceWithModel | null> {
    return db.userDevice.findUnique({
      where: { mac_id: macId },
      include: { device_model: true },
    });
  }

  async getActionsByDeviceId(userDeviceId: number): Promise<ActionWithDef[]> {
    return db.userAction.findMany({
      where: { user_device_id: userDeviceId },
      include: { action_def: true },
    });
  }

  // ─── Provisioning ─────────────────────────────────────────────────────────

  /** Find a placeholder device (null mac_id or legacy 'unbound:' prefix) for the given user + model key. */
  async getUnboundDevice(userId: number, modelKey: string): Promise<UserDevice | null> {
    return db.userDevice.findFirst({
      where: {
        user_id: userId,
        device_model: { model_key: modelKey },
        OR: [{ mac_id: null }, { mac_id: { startsWith: 'unbound:' } }],
      },
    });
  }

  /** Auto-create an empty UserDeviceModel + placeholder UserDevice for a first-time registration. */
  async createDeviceSlot(userId: number, modelKey: string, version: string): Promise<UserDevice> {
    const displayName = modelKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    let model = await db.userDeviceModel.findFirst({ where: { user_id: userId, model_key: modelKey } });
    if (!model) {
      model = await db.userDeviceModel.create({
        data: { user_id: userId, model_key: modelKey, version, display_name: displayName },
      });
    }

    return db.userDevice.create({
      data: { user_id: userId, user_device_model_id: model.id, name: displayName },
    });
  }

  /** Bind a real mac_id to an unbound placeholder device. */
  async bindDevice(id: number, macId: string): Promise<UserDevice> {
    return db.userDevice.update({
      where: { id },
      data: { mac_id: macId, online: false, updated_at: new Date() },
    });
  }

  /** Upsert UserActionDef rows from device self-reported capabilities. Idempotent. */
  async upsertActionDefs(deviceModelId: number, capabilities: CapabilityReport[]): Promise<void> {
    for (const cap of capabilities) {
      let googleType = await db.googleActionType.findUnique({ where: { key: cap.google_action_type } });
      if (!googleType) {
        googleType = await db.googleActionType.create({
          data: { key: cap.google_action_type, name: cap.google_action_type },
        });
      }

      const pins = cap.pin_types ? cap.pin_types.map(t => ({ type: t })) : [];

      const def = await db.userActionDef.upsert({
        where: { user_device_model_id_action_key: { user_device_model_id: deviceModelId, action_key: cap.action_key } },
        update: { mqtt_type: cap.mqtt_type, pins, google_action_type_id: googleType.id },
        create: {
          user_device_model_id: deviceModelId,
          action_key: cap.action_key,
          capability: cap.capability,
          mqtt_type: cap.mqtt_type,
          mqtt_name: null,
          pins,
          telemetry_interval_ms: null,
          google_action_type_id: googleType.id,
        },
      });

      for (const traitKey of cap.google_traits ?? []) {
        let trait = await db.googleTrait.findUnique({ where: { key: traitKey } });
        if (!trait) {
          trait = await db.googleTrait.create({ data: { key: traitKey, name: traitKey } });
        }
        await db.userActionDefTrait.upsert({
          where: { user_action_def_id_google_trait_id: { user_action_def_id: def.id, google_trait_id: trait.id } },
          update: {},
          create: { user_action_def_id: def.id, google_trait_id: trait.id },
        });
      }
    }
  }

  /** Create UserAction rows for a newly bound device (from the device model's action defs). */
  async createActionsForDevice(userDeviceId: number, deviceModelId: number): Promise<UserAction[]> {
    const defs = await db.userActionDef.findMany({ where: { user_device_model_id: deviceModelId } });
    if (!defs.length) return [];

    await db.userAction.createMany({
      data: defs.map((def, i) => ({
        user_device_id: userDeviceId,
        user_action_def_id: def.id,
        name: def.action_key,
        sort_order: i + 1,
      })),
      skipDuplicates: true,
    });

    return db.userAction.findMany({
      where: { user_device_id: userDeviceId },
      include: { action_def: true },
    });
  }

  // ─── Device config (firmware pull) ───────────────────────────────────────

  /** Return all action defs for a device — firmware uses this for MQTT topic + pin config. */
  async getActionDefsForDevice(userDeviceId: number): Promise<UserActionDef[]> {
    const actions = await db.userAction.findMany({
      where: { user_device_id: userDeviceId },
      include: { action_def: true },
      orderBy: { sort_order: 'asc' },
    });
    return actions.map((a) => a.action_def);
  }

  // ─── Online status ────────────────────────────────────────────────────────

  async setOnlineStatus(id: number, online: boolean): Promise<void> {
    await db.userDevice.update({
      where: { id },
      data: { online, last_seen_at: new Date(), updated_at: new Date() },
    });
  }

  // ─── Emergency events (async write, fire-and-forget from hot path) ────────

  async logEmergencyEvent(ruleId: number, value: string, traceId?: string): Promise<void> {
    await db.emergencyEvent.create({ data: { emergency_rule_id: ruleId, value, trace_id: traceId } });
  }

  // ─── Emergency rules (for cache warm-up) ─────────────────────────────────

  async getEnabledEmergencyRules(userId: number) {
    return db.emergencyRule.findMany({ where: { user_id: userId, enabled: true } });
  }

  async getEnabledEmergencyRulesForAction(actionId: number, capability: string) {
    return db.emergencyRule.findMany({
      where: {
        enabled: true,
        OR: [
          { source_user_action_id: actionId },
          { source_scope: 'capability', source_capability: capability },
        ],
      },
    });
  }
}

export const deviceGatewayRepository = new DeviceGatewayRepository();
