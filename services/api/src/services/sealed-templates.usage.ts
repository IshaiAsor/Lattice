import { db } from '../db';

// F10.10 — the reverse lookup from a sealed template to the blueprints that depend on it.
//
// A blueprint addresses a device action as (slot_key, mqtt_action_name), resolved at derive and
// reconcile time against the entries of the slot's sealed template. Publish validation guards that
// pair in the *forward* direction only (blueprints.admin.validation: "does this template provide
// that action?"), and it runs when the blueprint is published — so a template edited afterwards can
// strand a reference that was legal when it was written. Nothing throws when it does: the entity
// resolves to nothing at the next derive/reconcile and is simply skipped, which is the quiet
// degradation this module exists to prevent.
//
// The stranding is not only a hand-typed rename. Entry names are POSITIONAL — assignMqttNames gives
// the first instance of a capability its base name and suffixes the rest (_2, _3…) — so deleting
// the first of three `i2c_socket_8` entries silently renames the two below it. That is why the
// check compares the whole *name set* a save would produce, not the rows the admin visibly touched.

/** One place a blueprint addresses one action on one slot. */
export interface BlueprintActionRef {
  slot_key: string;
  action_name: string;
  /** Human-readable origin, e.g. `rule "refill_tank" action` — this is what the admin is shown. */
  where: string;
}

/** A blueprint that has at least one slot bound to the template, and how it addresses it. */
export interface TemplateUsage {
  blueprint_id: number;
  key: string;
  name: string;
  status: string;
  /** Slots of this blueprint that this template fills. */
  slot_keys: string[];
  /** Every action reference through those slots. */
  refs: BlueprintActionRef[];
  /** Refs that do not resolve against the template's *current* entries (see strandedReferences). */
  stranded: string[];
}

// The shape of the addressing surface, structural rather than the Prisma payload type: the
// collector below is pure so the "did we miss a place that addresses an action?" question can be
// pinned by a unit test without a database.
export interface AddressingBlueprint {
  scenes: { key: string; members: { slot_key: string; action_name: string }[] }[];
  rules: {
    key: string;
    conditions: { slot_key: string | null; action_name: string | null }[];
    actions: { slot_key: string; action_name: string }[];
  }[];
  pipelines: {
    key: string;
    sensors: { slot_key: string; action_name: string }[];
    triggers: { slot_key: string | null; action_name: string | null }[];
  }[];
}

/**
 * Every (slot_key, action_name) a blueprint addresses, from all five places that can hold one.
 *
 * Keep this in step with the forward guard in blueprints.admin.validation (`checkTarget` call
 * sites): a place that can address an action but is not collected here is a place a template edit
 * can silently break.
 */
export function collectActionRefs(bp: AddressingBlueprint): BlueprintActionRef[] {
  const refs: BlueprintActionRef[] = [];
  const add = (where: string, slotKey?: string | null, actionName?: string | null): void => {
    // A row with no action (a schedule condition, a time trigger) addresses no entry and cannot be
    // stranded by an entry edit.
    if (slotKey && actionName) refs.push({ slot_key: slotKey, action_name: actionName, where });
  };

  for (const scene of bp.scenes) {
    for (const m of scene.members) add(`scene "${scene.key}" member`, m.slot_key, m.action_name);
  }
  for (const rule of bp.rules) {
    for (const c of rule.conditions) add(`rule "${rule.key}" condition`, c.slot_key, c.action_name);
    for (const a of rule.actions) add(`rule "${rule.key}" action`, a.slot_key, a.action_name);
  }
  for (const pipeline of bp.pipelines) {
    for (const s of pipeline.sensors) {
      add(`pipeline "${pipeline.key}" sensor`, s.slot_key, s.action_name);
    }
    for (const t of pipeline.triggers) {
      add(`pipeline "${pipeline.key}" trigger`, t.slot_key, t.action_name);
    }
  }
  return refs;
}

/**
 * The references `actionNames` would leave unresolvable, as admin-facing lines.
 *
 * `actionNames` is the entry-name set of a *proposed* save (or of the stored template, to report
 * what is already broken). Only published blueprints are considered by callers that block a save —
 * a draft is still held by the publish gate, which validates against the template as it will then
 * be, so blocking on one would forbid editing a template while any draft mentions it.
 */
export function strandedReferences(usage: TemplateUsage, actionNames: Set<string>): string[] {
  return usage.refs
    .filter((r) => !actionNames.has(r.action_name))
    .map(
      (r) =>
        `"${usage.name}" (${usage.status}) — ${r.where} addresses "${r.action_name}" on slot "${r.slot_key}"`,
    );
}

/**
 * Which blueprints depend on this sealed template, and how.
 *
 * `BlueprintSlot.sealed_template_id` is a real FK (onDelete: Restrict), so this is exact for saved
 * blueprints. Import *documents* name the template by string instead — which is why renaming a
 * template is still a deprecate-and-add matter for anything exported and re-imported.
 */
export async function findTemplateUsage(templateId: number): Promise<TemplateUsage[]> {
  const slots = await db.blueprintSlot.findMany({
    where: { sealed_template_id: templateId },
    select: { key: true, blueprint_id: true },
  });
  if (slots.length === 0) return [];

  // One blueprint may fill several slots from the same template (two identical boards, say), so the
  // refs of interest are those through *any* of its slots.
  const slotKeysByBlueprint = new Map<number, Set<string>>();
  for (const s of slots) {
    const keys = slotKeysByBlueprint.get(s.blueprint_id) ?? new Set<string>();
    keys.add(s.key);
    slotKeysByBlueprint.set(s.blueprint_id, keys);
  }

  const [blueprints, entries] = await Promise.all([
    db.blueprint.findMany({
      where: { id: { in: [...slotKeysByBlueprint.keys()] } },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        key: true,
        name: true,
        status: true,
        scenes: {
          select: { key: true, members: { select: { slot_key: true, action_name: true } } },
        },
        rules: {
          select: {
            key: true,
            conditions: { select: { slot_key: true, action_name: true } },
            actions: { select: { slot_key: true, action_name: true } },
          },
        },
        pipelines: {
          select: {
            key: true,
            sensors: { select: { slot_key: true, action_name: true } },
            triggers: { select: { slot_key: true, action_name: true } },
          },
        },
      },
    }),
    db.sealedTemplateEntry.findMany({
      where: { template_id: templateId },
      select: { mqtt_action_name: true },
    }),
  ]);

  const currentNames = new Set(entries.map((e) => e.mqtt_action_name));
  return blueprints.map((bp) => {
    const slotKeys = slotKeysByBlueprint.get(bp.id) ?? new Set<string>();
    const usage: TemplateUsage = {
      blueprint_id: bp.id,
      key: bp.key,
      name: bp.name,
      status: bp.status,
      slot_keys: [...slotKeys].sort(),
      refs: collectActionRefs(bp).filter((r) => slotKeys.has(r.slot_key)),
      stranded: [],
    };
    // Reported, not thrown: a template that was force-saved (or changed by a seed) leaves this
    // behind, and the editor is where an admin can see it.
    usage.stranded = strandedReferences(usage, currentNames);
    return usage;
  });
}
