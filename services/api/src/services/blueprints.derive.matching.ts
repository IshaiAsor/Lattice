import { db, Prisma } from '../db';
import { versionInRange } from '@lattice/capability-validation';

// Slot matching for derive: which of a user's sealed devices can fill each blueprint slot, and
// what the derive would auto-bind without asking. Split out of the derive service so the loaded-
// blueprint include, the preview shape, and the matching itself sit apart from the binding +
// materialization flow. Read-only — the derive service owns all writes.

// Hoisted so the payload types can be named (TS2742 — an inline include leaks an unnameable
// `.prisma/client/runtime` type into the exported service object).
export const deriveInclude = {
  slots: {
    include: { sealed_template: { include: { targets: true } } },
    orderBy: { sort_order: 'asc' },
  },
  params: true,
  // The dynamic form (F11.6) — the questions the wizard asks and, on a select, which profile each
  // answer implies.
  fields: {
    orderBy: { sort_order: 'asc' },
    include: { options: { orderBy: { sort_order: 'asc' } } },
  },
  // Phases hang off a profile (F11); derive needs every profile so a binding can be put on one.
  profiles: {
    orderBy: { sort_order: 'asc' },
    include: { phases: { include: { targets: true }, orderBy: { ordinal: 'asc' } } },
  },
  scenes: { include: { members: { orderBy: { sort_order: 'asc' } } } },
  rules: { include: { conditions: true, actions: true } },
  pipelines: {
    include: { sensors: true, stages: { orderBy: { ordinal: 'asc' } }, triggers: true },
  },
} satisfies Prisma.BlueprintInclude;

export type DerivableBlueprint = Prisma.BlueprintGetPayload<{ include: typeof deriveInclude }>;

export interface SlotCandidate {
  user_device_id: number;
  name: string;
  // Two sealed boards of the same type carry the same name until the user renames one, which is
  // the normal case for a multi-instance blueprint. The MAC is the only thing that tells them
  // apart, so the wizard needs it to label a choice honestly.
  mac_id: string;
  device_type: string;
  version: string;
  // False when the device is already bound to an instance of any blueprint. Such a device is still
  // listed — showing it greyed out explains why the slot looks short-handed, where dropping it
  // silently would not — but it cannot be bound again: two setups driving the same actions on one
  // board would fight each other, and the second derive would quietly retune the first.
  free: boolean;
}

export interface SlotMatch {
  slot_key: string;
  label: string;
  required: boolean;
  min_count: number;
  max_count: number;
  /** Each device bound here runs its own lifecycle, so the wizard must ask which profile. */
  profiled: boolean;
  sealed_template: string;
  candidates: SlotCandidate[];
  // The devices derive would bind with no user input. Populated when the candidate set is
  // unambiguous: for a single-device slot that means exactly one candidate; for a multi-device
  // slot (max_count > 1) it means "take them all" as long as the count fits the slot. Empty when
  // the user must choose (too many candidates for the slot to fill on its own).
  auto_bind: number[];
}

/** A lifecycle a profiled slot's device can be put on — what the wizard offers per device (F11). */
export interface ProfileOption {
  key: string;
  label: string;
}

/**
 * One question the wizard asks (F11.6). `scope: 'binding'` is asked once per bound device of
 * `slot_key`; `setup` once for the whole setup.
 *
 * An option's `profile_key` is what lets a single question do two jobs — record what the user said
 * *and* put that device on the matching lifecycle — so the wizard never has to ask "and which
 * profile?" separately.
 */
export interface FieldPrompt {
  key: string;
  label: string;
  help_text: string | null;
  input_type: string;
  scope: string;
  slot_key: string | null;
  required: boolean;
  default_value: string | null;
  options: { value: string; label: string; profile_key: string | null }[];
}

export interface DerivePreview {
  blueprint_id: number;
  key: string;
  name: string;
  version: number;
  slots: SlotMatch[];
  /** The lifecycles a profiled slot's devices can be put on. Empty when the blueprint has none. */
  profiles: ProfileOption[];
  /** The form to render before deriving. Empty when the blueprint asks nothing. */
  fields: FieldPrompt[];
  // Empty ⇒ every required slot can be satisfied without the user choosing anything.
  unmet: string[];
}

/** The declared form, in the shape the wizard renders. */
export function fieldPrompts(bp: DerivableBlueprint): FieldPrompt[] {
  return bp.fields.map((f) => ({
    key: f.key,
    label: f.label,
    help_text: f.help_text,
    input_type: f.input_type,
    scope: f.scope,
    slot_key: f.slot_key,
    required: f.required,
    default_value: f.default_value,
    options: f.options.map((o) => ({
      value: o.value,
      label: o.label,
      profile_key: o.profile_key,
    })),
  }));
}

// The user's sealed devices whose (type, version) each slot's sealed template covers — the same
// match sealed-templates.service uses to count affected devices, applied per user.
export async function matchSlots(userId: number, bp: DerivableBlueprint): Promise<SlotMatch[]> {
  const devices = await db.userDevice.findMany({
    where: { user_id: userId, device: { is_sealed: true } },
    select: {
      id: true,
      name: true,
      mac_id: true,
      device: { select: { type: true, version: true } },
      blueprint_bindings: { select: { id: true }, take: 1 },
    },
    orderBy: { id: 'asc' },
  });

  return bp.slots.map((slot) => {
    const candidates: SlotCandidate[] = devices
      .filter((d) =>
        slot.sealed_template.targets.some(
          (t) =>
            t.device_type === d.device.type &&
            versionInRange(d.device.version, t.version_min, t.version_max),
        ),
      )
      .map((d) => ({
        user_device_id: d.id,
        name: d.name,
        mac_id: d.mac_id,
        device_type: d.device.type,
        version: d.device.version,
        free: d.blueprint_bindings.length === 0,
      }));
    // Auto-bind when the slot can fill itself unambiguously: at least one *bindable* candidate, and
    // no more than it can hold. A single-device slot (max_count 1) auto-binds only when exactly one
    // device is free; a multi-device slot grabs every free device up to its cap. More than the cap
    // ⇒ the user must pick which subset. Devices bound elsewhere are never auto-bound — they are
    // not offered by hand either, so taking one silently would be the one way past that rule.
    const bindable = candidates.filter((c) => c.free);
    const auto_bind =
      bindable.length >= 1 && bindable.length <= slot.max_count
        ? bindable.map((c) => c.user_device_id)
        : [];
    return {
      slot_key: slot.key,
      label: slot.label,
      required: slot.required,
      min_count: slot.min_count,
      max_count: slot.max_count,
      profiled: slot.profiled,
      sealed_template: slot.sealed_template.name,
      candidates,
      auto_bind,
    };
  });
}

// A required slot the user cannot satisfy at all — fewer *free* devices than its minimum. Used by
// both the preview and the derivable-list to flag a blueprint as "needs a device". Counting only
// free devices is what makes the gallery honest: a blueprint whose one qualifying board is already
// running another setup is not something the user can set up today.
export function unmetSlots(slots: SlotMatch[]): string[] {
  return slots
    .filter(
      (s) => s.required && s.candidates.filter((c) => c.free).length < Math.max(s.min_count, 1),
    )
    .map((s) => s.slot_key);
}
