import { db } from '../db';

// Slot → action-id resolution, shared by derive and reconcile (both turn a blueprint's
// (slot_key, action_name) references into concrete user_device_action ids). Multi-device slots
// bind several devices, so a single reference fans out to one id per bound device — this is the
// one place that mapping is built, so the two services can't drift.
//
// Actions come from the sealed-template materialization done at provision time; this only reads
// them. Callers layer their own policy on top (derive fails on a missing action, reconcile marks
// the entity unresolvable), but both ask the same two questions: how many devices does this slot
// bind, and which action ids does (slot, action) resolve to.

export interface SlotActionResolver {
  /** How many devices are bound to a slot (0 = unbound). */
  deviceCount(slotKey: string): number;
  /** The user_device ids bound to a slot, in binding order. */
  devicesInSlot(slotKey: string): number[];
  /**
   * The user_device_action.id on every bound device of the slot that carries `actionName`, in
   * device order. A length below `deviceCount(slotKey)` means some bound device lacks the action.
   */
  actionIds(slotKey: string, actionName: string): number[];
}

export async function buildSlotActionResolver(
  bindings: { slot_key: string; user_device_id: number }[],
): Promise<SlotActionResolver> {
  const deviceIdsBySlot = new Map<string, number[]>();
  for (const b of bindings) {
    const arr = deviceIdsBySlot.get(b.slot_key) ?? [];
    arr.push(b.user_device_id);
    deviceIdsBySlot.set(b.slot_key, arr);
  }

  const allDeviceIds = [...new Set(bindings.map((b) => b.user_device_id))];
  const actions = allDeviceIds.length
    ? await db.userDeviceAction.findMany({
        where: { user_device_id: { in: allDeviceIds }, status: 'active' },
        select: { id: true, user_device_id: true, mqtt_action_name: true },
      })
    : [];

  // Keyed by slot, not device: two slots may legitimately bind the same device (one controller
  // running two halves of a setup), so each slot gets its own entry. Built in slot-device order so
  // the fanned-out ids are stable.
  const byKey = new Map<string, number[]>();
  for (const [slotKey, deviceIds] of deviceIdsBySlot) {
    for (const deviceId of deviceIds) {
      for (const action of actions) {
        if (action.user_device_id !== deviceId) continue;
        const key = `${slotKey}:${action.mqtt_action_name}`;
        const arr = byKey.get(key) ?? [];
        arr.push(action.id);
        byKey.set(key, arr);
      }
    }
  }

  return {
    deviceCount: (slotKey) => deviceIdsBySlot.get(slotKey)?.length ?? 0,
    devicesInSlot: (slotKey) => deviceIdsBySlot.get(slotKey) ?? [],
    actionIds: (slotKey, actionName) => byKey.get(`${slotKey}:${actionName}`) ?? [],
  };
}
