// Blueprint tiers (F18.12), addressed by (blueprint_id, slot_key, action_name) so a blueprint
// can single out its known-noisy sensor without touching the switches beside it.
//
// Admin-only: a user cannot edit the definition their instance inherits; they override it at their
// own device or action scope, which sits above blueprint in the resolution order.
//
// A list names its slot by KEY and its action by NAME rather than pointing at rows, because a
// blueprint save deletes and recreates every slot row and a sealed-template save every entry row.
// So this file also owns what happens to a list when the slot or action it names stops existing
// (`dropBlueprintTiers`, F18.20) — the failure F18.21 fixed for sealed lists, one scope up.

import { badRequest, type Tier } from '@lattice/retention';
import { db } from '../db';
import { retentionActivityService } from './retention-activity.service';
import { actionRetentionView, loadDeviceResolution } from './retention-device-resolution';
import { retentionUsageService } from './retention-usage.service';
import {
  assertActionScoped,
  assertKind,
  kindOfImplementation,
  listOf,
  parseTiers,
  replaceBlueprintTiers,
  validate,
} from './retention-tiers.shared';

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

/** The shape `slotActionNames` reads: each slot's key and its sealed template's entry names. */
interface SlotWithEntries {
  key: string;
  sealed_template: { entries: { mqtt_action_name: string }[] };
}

const slotSelect = {
  key: true,
  sealed_template: { select: { entries: { select: { mqtt_action_name: true } } } },
} as const;

/** Per slot key, the action names that slot can address — its sealed template's entries. */
export function slotActionNames(slots: readonly SlotWithEntries[]): Map<string, Set<string>> {
  return new Map(
    slots.map((s) => [s.key, new Set(s.sealed_template.entries.map((e) => e.mqtt_action_name))]),
  );
}

/**
 * The actions of a bound device that its slot addresses — those whose name is an entry of the slot's
 * sealed template — in the device's own order. Pure, for the setup page's Data tab: a board may
 * carry actions the blueprint never mentions, and those are not the setup's to show.
 */
export function slotActionsOf<A extends { mqtt_action_name: string }>(
  actions: readonly A[],
  entryNames: ReadonlySet<string> | undefined,
): A[] {
  if (!entryNames) return [];
  return actions.filter((a) => entryNames.has(a.mqtt_action_name));
}

async function loadBlueprint(blueprintId: number) {
  const bp = await db.blueprint.findUnique({
    where: { id: blueprintId },
    select: { name: true, slots: { select: slotSelect } },
  });
  if (!bp) throw notFound('Blueprint not found');
  return bp;
}

/**
 * The slot must exist on the SAVED blueprint and carry the action. A list for anything else would
 * resolve for nothing today and silently attach itself to whichever slot or entry a later save gives
 * that name.
 */
function assertSlotAction(
  bp: { name: string; slots: SlotWithEntries[] },
  slotKey: string,
  actionName: string,
): void {
  const names = slotActionNames(bp.slots).get(slotKey);
  if (!names) throw badRequest(`"${bp.name}" has no slot ${slotKey} — save the blueprint first`);
  if (!names.has(actionName))
    throw badRequest(`Slot ${slotKey} of "${bp.name}" has no action named ${actionName}`);
}

const label = (blueprintName: string, slotKey: string, actionName: string) =>
  `${blueprintName} · ${slotKey} · ${actionName}`;

type TierRow = {
  slot_key: string;
  action_name: string;
  data_kind: string;
  bucket: string;
  keep_days: number;
  position: number;
};

export interface StaleBlueprintList {
  slotKey: string;
  actionName: string;
  dataKind: string;
  tiers: Tier[];
}

/**
 * The (slot, action, kind) lists whose slot or action is not in `keep`, grouped. Pure — the decision
 * of what a save strands, kept testable without a database.
 *
 * `keep` maps each slot key to the action names it can address; `null` strands every list (the
 * blueprint is being deleted). A renamed slot key or a changed template is indistinguishable from a
 * removal here, and deliberately so: the list was written for what the slot WAS.
 */
export function staleBlueprintLists(
  rows: readonly TierRow[],
  keep: ReadonlyMap<string, ReadonlySet<string>> | null,
): StaleBlueprintList[] {
  const out = new Map<string, StaleBlueprintList>();
  for (const r of rows) {
    if (keep?.get(r.slot_key)?.has(r.action_name)) continue;
    const key = JSON.stringify([r.slot_key, r.action_name, r.data_kind]);
    let list = out.get(key);
    if (!list)
      out.set(
        key,
        (list = {
          slotKey: r.slot_key,
          actionName: r.action_name,
          dataKind: r.data_kind,
          tiers: [],
        }),
      );
    list.tiers.push({ bucket: r.bucket, keepDays: r.keep_days, position: r.position });
  }
  return [...out.values()];
}

/** Anything with the models this file reads and writes — the client or a transaction handle. */
type Client = Pick<
  typeof db,
  'blueprint' | 'blueprintSlot' | 'blueprintRetentionTier' | 'retentionActivity' | 'user'
>;

/**
 * Remove, and log, every blueprint list whose slot or action no longer exists.
 *
 * Run inside the transaction that changed the definition, AFTER its rows are written: the keep set is
 * read back from those rows, so it is the definition that will commit rather than a second
 * derivation of it that could disagree.
 *
 * - `{ blueprintId }` — a blueprint save replaced its slots.
 * - `{ blueprintId, deleting: true }` — every list goes; the FK cascade would otherwise remove them
 *   with no entry on the trail.
 * - `{ templateId }` — a sealed-template save replaced its entries, which can strand lists on every
 *   blueprint with a slot on that template.
 */
export async function dropBlueprintTiers(
  client: Client,
  scope: { blueprintId: number; deleting?: boolean } | { templateId: number },
  actorUserId: number | null,
  summary: string,
): Promise<void> {
  const blueprintIds =
    'templateId' in scope
      ? [
          ...new Set(
            (
              await client.blueprintSlot.findMany({
                where: { sealed_template_id: scope.templateId },
                select: { blueprint_id: true },
              })
            ).map((s) => s.blueprint_id),
          ),
        ]
      : [scope.blueprintId];
  const deleting = 'blueprintId' in scope && scope.deleting === true;

  // Sequential, not Promise.all: these run on one interactive-transaction connection.
  for (const blueprintId of blueprintIds) {
    const rows: TierRow[] = await client.blueprintRetentionTier.findMany({
      where: { blueprint_id: blueprintId },
      orderBy: [
        { slot_key: 'asc' },
        { action_name: 'asc' },
        { data_kind: 'asc' },
        { position: 'asc' },
      ],
    });
    if (rows.length === 0) continue;

    const bp = await client.blueprint.findUnique({
      where: { id: blueprintId },
      select: { name: true, slots: { select: slotSelect } },
    });
    const lists = staleBlueprintLists(rows, deleting || !bp ? null : slotActionNames(bp.slots));
    if (lists.length === 0) continue;

    await client.blueprintRetentionTier.deleteMany({
      where: {
        blueprint_id: blueprintId,
        OR: lists.map((l) => ({ slot_key: l.slotKey, action_name: l.actionName })),
      },
    });
    const name = bp?.name ?? `blueprint ${blueprintId}`;
    for (const l of lists) {
      await retentionActivityService.record(
        {
          action: 'tiers_reset',
          scope: 'blueprint',
          actorKind: 'admin',
          actorUserId,
          subjectUserId: null,
          subjectRefId: blueprintId,
          subjectLabel: label(name, l.slotKey, l.actionName),
          dataKind: l.dataKind,
          summary,
          before: l.tiers,
        },
        client,
      );
    }
  }
}

export const retentionBlueprintsService = {
  // ── Blueprint scope (admin only) ──────────────────────────────────────────
  //
  // A user cannot edit the definition their instance inherits; they override it at their own device
  // or action scope, which sits above blueprint in the resolution order.

  /**
   * A blueprint's retention as the builder shows it: per saved slot, each action its template
   * carries, with the kind it records, the blueprint's own list, and the sealed template's list it
   * falls back to (F18.20).
   *
   * Shaped by slot rather than as flat tier rows because the builder draws the saved slots — a list
   * can only be set on a slot the blueprint has actually saved, whatever the unsaved draft says.
   */
  async blueprintTiers(blueprintId: number) {
    const bp = await db.blueprint.findUnique({
      where: { id: blueprintId },
      select: {
        name: true,
        _count: { select: { instances: true } },
        slots: {
          orderBy: { sort_order: 'asc' },
          select: {
            key: true,
            label: true,
            sealed_template: {
              select: {
                id: true,
                name: true,
                entries: {
                  orderBy: { sort_order: 'asc' },
                  select: { mqtt_action_name: true, action_label: true, capability_key: true },
                },
              },
            },
          },
        },
      },
    });
    if (!bp) throw notFound('Blueprint not found');

    const templateIds = [...new Set(bp.slots.map((s) => s.sealed_template.id))];
    const capabilityKeys = [
      ...new Set(bp.slots.flatMap((s) => s.sealed_template.entries.map((e) => e.capability_key))),
    ];
    const [rows, sealedRows, capabilities] = await Promise.all([
      db.blueprintRetentionTier.findMany({ where: { blueprint_id: blueprintId } }),
      db.sealedRetentionTier.findMany({ where: { sealed_template_id: { in: templateIds } } }),
      // A capability's implementation is the same on every board that carries it, so any catalog
      // row answers which kind an entry records.
      db.deviceCapability.findMany({
        where: { capability_key: { in: capabilityKeys } },
        distinct: ['capability_key'],
        select: { capability_key: true, implementation_type: true },
      }),
    ]);
    const implOf = new Map(capabilities.map((c) => [c.capability_key, c.implementation_type]));

    return {
      blueprintId,
      name: bp.name,
      instanceCount: bp._count.instances,
      slots: bp.slots.map((s) => ({
        slotKey: s.key,
        slotLabel: s.label,
        templateId: s.sealed_template.id,
        templateName: s.sealed_template.name,
        actions: s.sealed_template.entries.map((e) => {
          const kind = kindOfImplementation(implOf.get(e.capability_key) ?? '');
          return {
            actionName: e.mqtt_action_name,
            label: e.action_label,
            dataKind: kind,
            own: listOf(
              rows,
              kind,
              (r) => r.slot_key === s.key && r.action_name === e.mqtt_action_name,
            ),
            sealed: listOf(
              sealedRows,
              kind,
              (r) =>
                r.sealed_template_id === s.sealed_template.id &&
                r.action_name === e.mqtt_action_name,
            ),
          };
        }),
      })),
    };
  },

  async setBlueprintTiers(
    blueprintId: number,
    slotKey: string,
    actionName: string,
    kind: string,
    body: Record<string, unknown>,
    adminId: number,
  ) {
    assertKind(kind);
    assertActionScoped(kind);
    const bp = await loadBlueprint(blueprintId);
    assertSlotAction(bp, slotKey, actionName);
    const tiers = parseTiers(body);
    await validate(kind, tiers, { applyCeilings: true });
    await replaceBlueprintTiers(blueprintId, slotKey, actionName, kind, tiers, {
      scope: 'blueprint',
      actorKind: 'admin',
      actorUserId: adminId,
      // No subject user: a blueprint tier is inherited by every instance, so it belongs to nobody
      // in particular and must not land in one user's feed.
      subjectUserId: null,
      subjectRefId: blueprintId,
      subjectLabel: label(bp.name, slotKey, actionName),
    });
    return this.blueprintTiers(blueprintId);
  },

  /**
   * Remove a slot action's list for one kind, so its devices fall back to the wider scope.
   *
   * There was no way to do this before F18.20: no route, and a PUT of an empty list is refused by
   * `assertTierList` (a list needs its raw tier), so a blueprint list, once set, was permanent.
   * No slot check — clearing a list whose slot has since gone is exactly what should be allowed.
   */
  async clearBlueprintTiers(
    blueprintId: number,
    slotKey: string,
    actionName: string,
    kind: string,
    adminId: number,
  ) {
    assertKind(kind);
    assertActionScoped(kind);
    const bp = await loadBlueprint(blueprintId);
    const where = {
      blueprint_id: blueprintId,
      slot_key: slotKey,
      action_name: actionName,
      data_kind: kind,
    };
    await db.$transaction(async (tx) => {
      const before = await tx.blueprintRetentionTier.findMany({
        where,
        orderBy: { position: 'asc' },
      });
      const { count } = await tx.blueprintRetentionTier.deleteMany({ where });
      if (count > 0) {
        await retentionActivityService.record(
          {
            action: 'tiers_reset',
            scope: 'blueprint',
            actorKind: 'admin',
            actorUserId: adminId,
            subjectUserId: null,
            subjectRefId: blueprintId,
            subjectLabel: label(bp.name, slotKey, actionName),
            dataKind: kind,
            summary: 'cleared — devices fall back to the wider scope',
            before: before.map((t) => ({
              bucket: t.bucket,
              keepDays: t.keep_days,
              position: t.position,
            })),
          },
          tx,
        );
      }
    });
    return this.blueprintTiers(blueprintId);
  },

  // ── A user's setup (owner only) ───────────────────────────────────────────

  /**
   * What each action in one of the user's setups keeps, and who decided it (F18.20).
   *
   * Per slot, per bound device, only the actions the slot addresses — resolved through the same
   * loader as the device page, so an action reads the same on both. The user keeps their own list at
   * the ACTION scope (there is no setup scope), which sits above blueprint.
   */
  async setupRetention(userId: number, instanceId: number) {
    const instance = await db.blueprintInstance.findUnique({
      where: { id: instanceId },
      select: {
        user_id: true,
        name: true,
        blueprint: {
          select: {
            id: true,
            name: true,
            slots: { orderBy: { sort_order: 'asc' }, select: { ...slotSelect, label: true } },
          },
        },
        bindings: {
          orderBy: { id: 'asc' },
          select: { slot_key: true, user_device_id: true, label: true },
        },
      },
    });
    // 404 missing, 403 not yours — the codes every other setup endpoint answers with.
    if (!instance) throw notFound('Setup not found');
    if (instance.user_id !== userId)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });

    const names = slotActionNames(instance.blueprint.slots);
    const devices = await Promise.all(
      instance.bindings.map(async (b) => {
        const r = await loadDeviceResolution(userId, b.user_device_id);
        const actions = slotActionsOf(r.actions, names.get(b.slot_key));
        const stored = await retentionUsageService.usageByAction(actions.map((a) => a.id));
        return {
          slotKey: b.slot_key,
          deviceId: b.user_device_id,
          deviceName: b.label ?? r.deviceName,
          actions: actions.map((a) => actionRetentionView(r, a, stored.get(a.id))),
        };
      }),
    );

    return {
      instanceId,
      name: instance.name,
      blueprintId: instance.blueprint.id,
      blueprintName: instance.blueprint.name,
      slots: instance.blueprint.slots
        .map((s) => ({
          slotKey: s.key,
          slotLabel: s.label,
          devices: devices
            .filter((d) => d.slotKey === s.key)
            .map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, actions: d.actions })),
        }))
        .filter((s) => s.devices.length > 0),
    };
  },
};
