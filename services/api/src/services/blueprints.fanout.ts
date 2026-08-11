// Template fan-out (F11.2 / F11.9) — how ONE template becomes one automation or several, and
// which of a slot's devices each one covers.
//
// A blueprint template addresses slots, and a slot may bind several devices. Until F11 that always
// produced exactly one entity naming every bound device ("alert if any of them reports X"), which
// is still the default and still the right shape for anything the whole setup shares.
//
// It is the wrong shape the moment those devices are on *different lifecycles*: one entity has one
// resolution context, so a single `@phase.threshold` cannot mean two things at once. `per_device`
// is the answer — one entity per binding of the named slot, each carrying `blueprint_binding_id`
// and resolving that slot to its own device.
//
// Two independent questions, then, and F11.9 separates them properly:
//
//   fan_out          how MANY entities   — one for the group (combined) or one each (per_device)
//   fan_out_profiles WHICH devices       — every bound device (empty) or only those following one
//                                          of the named lifecycles
//
// so "this automation is for all three devices", "…for that one", and "…for two of the three" are
// all sayable. The selector is a list of *lifecycles* rather than devices because a template is
// authored before the user owns anything, and because a device moved onto another lifecycle then
// joins and leaves the right automations on its own instead of leaving a stale device list behind.
//
// Shared by derive (which creates the entities) and reconcile (which matches them again on the
// next publish). Both must agree on how many entities a template produces and which binding each
// belongs to, so the rule lives here once rather than in each of them.

/** One entity a template will produce. */
export interface FanTarget {
  /**
   * The one device this entity belongs to, or null when it spans a group. Drives
   * `blueprint_binding_id`, and so the reconcile identity and the resolution context.
   */
  deviceId: number | null;
  /**
   * What the fan-out slot narrows to, or null for "every device bound to it".
   *
   * Separate from `deviceId` because a *combined* entity over a subset covers several devices and
   * still belongs to no single binding — it needs the narrowing without the identity.
   */
  deviceIds: number[] | null;
  /** What to append to the entity's name so several copies are tellable apart. */
  suffix: string | null;
}

/** The single target a combined template has: everything, named as the template names it. */
export const COMBINED_TARGET: FanTarget = { deviceId: null, deviceIds: null, suffix: null };

export interface FanOutTemplate {
  fan_out: string;
  fan_out_slot_key: string | null;
  /** Lifecycles whose devices take part; empty = all of them. */
  fan_out_profiles?: string[];
}

export interface FanOutBinding {
  slot_key: string;
  user_device_id: number;
  label?: string | null;
  /** The lifecycle this device follows; null on a shared (unprofiled) slot. */
  profile_key?: string | null;
}

/** The bindings of the fan-out slot the template's profile selector keeps. */
function selected(template: FanOutTemplate, bindings: FanOutBinding[]): FanOutBinding[] {
  const inSlot = bindings.filter((b) => b.slot_key === template.fan_out_slot_key);
  const profiles = template.fan_out_profiles ?? [];
  if (profiles.length === 0) return inSlot;
  return inSlot.filter((b) => b.profile_key !== null && profiles.includes(b.profile_key ?? ''));
}

/**
 * The entities `template` produces over `bindings`.
 *
 * Yields **no** targets — so the template produces nothing — when the selection is empty: a
 * `per_device` template over an unbound slot, or either shape restricted to lifecycles no bound
 * device follows. That is the same outcome as the `skip` a combined template already takes when it
 * references an unbound optional slot, reached one step earlier.
 */
export function fanTargets(
  template: FanOutTemplate,
  bindings: FanOutBinding[],
  deviceNames: Map<number, string>,
): FanTarget[] {
  const restricted = (template.fan_out_profiles ?? []).length > 0;
  if (!template.fan_out_slot_key) return [COMBINED_TARGET];

  if (template.fan_out === 'per_device') {
    return selected(template, bindings).map((b) => ({
      deviceId: b.user_device_id,
      deviceIds: [b.user_device_id],
      suffix: b.label ?? deviceNames.get(b.user_device_id) ?? `#${b.user_device_id}`,
    }));
  }

  // Combined. Without a selector this is pre-F11 behaviour exactly, down to leaving the resolver
  // unnarrowed. With one, the single entity covers just the chosen devices — and keeps the
  // template's own name, since there is only ever one of it to tell apart.
  if (!restricted) return [COMBINED_TARGET];
  const deviceIds = selected(template, bindings).map((b) => b.user_device_id);
  return deviceIds.length > 0 ? [{ deviceId: null, deviceIds, suffix: null }] : [];
}

/** "Water low · Loop A" — a per-device entity names itself after the device it belongs to. */
export function fannedName(base: string, target: FanTarget): string {
  return target.suffix ? `${base} · ${target.suffix}` : base;
}
