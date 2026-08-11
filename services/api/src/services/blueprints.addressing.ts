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
  /**
   * The same resolver with `slotKey` narrowed to `deviceIds` — fan-out (F11.2/F11.9). One device
   * for a per-device entity; the chosen few for a combined entity restricted to some lifecycles.
   *
   * Every other slot still resolves to all of its devices, which is exactly what a per-device rule
   * needs: *this* device's own sensor, but the setup's shared actuator. Derived by re-keying the
   * in-memory map, so fanning one template over six devices costs no extra queries.
   *
   * The narrowed list keeps binding order rather than the caller's, so `actionIds` stays aligned
   * with `devicesInSlot` and a subset resolves in the same order the whole slot would.
   */
  scopedTo(slotKey: string, deviceIds: number[]): SlotActionResolver;
}

/**
 * The pure half: everything above, over maps the caller already holds.
 *
 * Exported so the narrowing rule can be unit-tested without a database — `scopedTo` is the piece a
 * per-device automation's whole correctness rests on, and it is not obvious from an integration
 * test whether a device got its own action or the whole slot's.
 */
export function buildResolverFrom(
  deviceIdsBySlot: Map<string, number[]>,
  /** `${user_device_id}:${mqtt_action_name}` → user_device_action.id */
  actionIdByDevice: Map<string, number>,
): SlotActionResolver {
  const devicesInSlot = (slotKey: string): number[] => deviceIdsBySlot.get(slotKey) ?? [];
  return {
    deviceCount: (slotKey) => devicesInSlot(slotKey).length,
    devicesInSlot,
    actionIds: (slotKey, actionName) =>
      devicesInSlot(slotKey)
        .map((deviceId) => actionIdByDevice.get(`${deviceId}:${actionName}`))
        .filter((id): id is number => id !== undefined),
    scopedTo: (slotKey, deviceIds) => {
      const keep = new Set(deviceIds);
      const narrowed = devicesInSlot(slotKey).filter((id) => keep.has(id));
      return buildResolverFrom(new Map(deviceIdsBySlot).set(slotKey, narrowed), actionIdByDevice);
    },
  };
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

  // Keyed by (device, action) rather than (slot, action): the slot→devices map is the only thing
  // narrowing changes, so scoping a slot to one device is a re-key of a small map instead of a
  // second pass over the actions. Two slots binding the same device (one controller running two
  // halves of a setup) still resolve independently, because each asks for its own device list.
  const actionIdByDevice = new Map<string, number>();
  for (const action of actions) {
    actionIdByDevice.set(`${action.user_device_id}:${action.mqtt_action_name}`, action.id);
  }

  return buildResolverFrom(deviceIdsBySlot, actionIdByDevice);
}
