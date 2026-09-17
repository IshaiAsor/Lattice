// Sealed template tiers (F18.21), addressed by (sealed_template_id, action_name) so a template can
// ship a `5m` tier on its fast-sampling entry and leave the switch beside it on raw.
//
// Admin-only, like blueprint tiers: a user cannot edit the definition their device inherits; they
// override it at their own device or action scope, which sits above sealed in the resolution order.
//
// `action_name` is the entry's `mqtt_action_name`. It is the stable identity rather than the entry
// row, because a template save deletes and recreates every entry row — so this file also owns what
// happens to a list when its entry is removed from the template (`dropSealedTiers`).

import { badRequest, isActionScopedKind, type DataKind, type Tier } from '@lattice/retention';
import { db } from '../db';
import { retentionActivityService } from './retention-activity.service';
import {
  assertKind,
  parseTiers,
  replaceSealedTiers,
  validate,
  view,
} from './retention-tiers.shared';

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

/** The template's name and its entry names — enough to label a log entry and address a list. */
async function loadTemplate(templateId: number) {
  const t = await db.sealedTemplate.findUnique({
    where: { id: templateId },
    select: { name: true, entries: { select: { mqtt_action_name: true } } },
  });
  if (!t) throw notFound('Sealed template not found');
  return t;
}

/**
 * Only the kinds whose history belongs to an action.
 *
 * `command` and `device_event` windows are resolved per user, so a sealed row for them would be
 * stored, shown, and silently never applied — refused instead of accepted and ignored.
 */
function assertActionScoped(kind: DataKind): void {
  if (!isActionScopedKind(kind))
    throw badRequest(
      `${kind} history is kept per user, not per board — set it in the user or platform list`,
    );
}

/**
 * The entry must exist. A list for a name the template does not carry would resolve for nothing
 * today and silently attach itself to whichever entry is later given that name.
 */
function assertEntry(
  template: { name: string; entries: { mqtt_action_name: string }[] },
  actionName: string,
): void {
  if (!template.entries.some((e) => e.mqtt_action_name === actionName))
    throw badRequest(
      `"${template.name}" has no action named ${actionName} — save the template first`,
    );
}

const label = (templateName: string, actionName: string) => `${templateName} · ${actionName}`;

type TierRow = {
  action_name: string;
  data_kind: string;
  bucket: string;
  keep_days: number;
  position: number;
};

/** Anything with the models this file writes — the client or a transaction handle. */
type Client = Pick<typeof db, 'sealedRetentionTier' | 'retentionActivity' | 'user'>;

/**
 * Remove the lists of entries that are no longer in the template, logging each one.
 *
 * `keep` is the entry-name set the template will have; `null` removes every list (template deleted).
 * Run in the caller's transaction so a template save and the lists it strands commit together.
 *
 * Why remove rather than leave them: a template save may later give a NEW entry a name an old one
 * had, and a leftover list would silently attach itself to it. The log entry keeps the record the
 * row no longer can.
 */
export async function dropSealedTiers(
  client: Client,
  templateId: number,
  templateName: string,
  keep: ReadonlySet<string> | null,
  actorUserId: number | null,
  summary: string,
): Promise<void> {
  const rows: TierRow[] = await client.sealedRetentionTier.findMany({
    where: { sealed_template_id: templateId },
    orderBy: [{ action_name: 'asc' }, { data_kind: 'asc' }, { position: 'asc' }],
  });
  const lists = staleSealedLists(rows, keep);
  if (lists.length === 0) return;

  await client.sealedRetentionTier.deleteMany({
    where: {
      sealed_template_id: templateId,
      action_name: { in: [...new Set(lists.map((l) => l.actionName))] },
    },
  });
  for (const l of lists) {
    await retentionActivityService.record(
      {
        action: 'tiers_reset',
        scope: 'sealed',
        actorKind: 'admin',
        actorUserId,
        subjectUserId: null,
        subjectRefId: templateId,
        subjectLabel: label(templateName, l.actionName),
        dataKind: l.dataKind,
        summary,
        before: l.tiers,
      },
      client,
    );
  }
}

/**
 * The (action, kind) lists whose entry is not in `keep`, grouped. Pure — the decision of what a
 * template save strands, kept testable without a database.
 */
export function staleSealedLists(
  rows: readonly TierRow[],
  keep: ReadonlySet<string> | null,
): { actionName: string; dataKind: string; tiers: Tier[] }[] {
  const out = new Map<string, { actionName: string; dataKind: string; tiers: Tier[] }>();
  for (const r of rows) {
    if (keep?.has(r.action_name)) continue;
    const key = `${r.action_name}\u0000${r.data_kind}`;
    let list = out.get(key);
    if (!list)
      out.set(key, (list = { actionName: r.action_name, dataKind: r.data_kind, tiers: [] }));
    list.tiers.push({ bucket: r.bucket, keepDays: r.keep_days, position: r.position });
  }
  return [...out.values()];
}

export const retentionSealedService = {
  /** Every list a template carries, one row per tier. */
  async sealedTiers(templateId: number) {
    await loadTemplate(templateId);
    const rows = await db.sealedRetentionTier.findMany({
      where: { sealed_template_id: templateId },
      orderBy: [{ action_name: 'asc' }, { data_kind: 'asc' }, { position: 'asc' }],
    });
    return rows.map((r) => ({ actionName: r.action_name, dataKind: r.data_kind, ...view(r) }));
  },

  async setSealedTiers(
    templateId: number,
    actionName: string,
    kind: string,
    body: Record<string, unknown>,
    adminId: number,
  ) {
    assertKind(kind);
    assertActionScoped(kind);
    const template = await loadTemplate(templateId);
    assertEntry(template, actionName);
    const tiers = parseTiers(body);
    await validate(kind, tiers, { applyCeilings: true });
    await replaceSealedTiers(templateId, actionName, kind, tiers, {
      scope: 'sealed',
      actorKind: 'admin',
      actorUserId: adminId,
      // No subject user: a sealed tier is inherited by every device of the type, so it belongs to
      // nobody in particular and must not land in one user's feed.
      subjectUserId: null,
      subjectRefId: templateId,
      subjectLabel: label(template.name, actionName),
    });
    return this.sealedTiers(templateId);
  },

  /**
   * Remove an entry's list for one kind, so its devices fall back to the wider scope.
   *
   * Deleting the rows, not writing the platform list into them — the same reason `resetMine` does:
   * a copy would freeze every device of the type at today's platform values.
   */
  async clearSealedTiers(templateId: number, actionName: string, kind: string, adminId: number) {
    assertKind(kind);
    assertActionScoped(kind);
    const template = await loadTemplate(templateId);
    await db.$transaction(async (tx) => {
      const before = await tx.sealedRetentionTier.findMany({
        where: { sealed_template_id: templateId, action_name: actionName, data_kind: kind },
        orderBy: { position: 'asc' },
      });
      const { count } = await tx.sealedRetentionTier.deleteMany({
        where: { sealed_template_id: templateId, action_name: actionName, data_kind: kind },
      });
      if (count > 0) {
        await retentionActivityService.record(
          {
            action: 'tiers_reset',
            scope: 'sealed',
            actorKind: 'admin',
            actorUserId: adminId,
            subjectUserId: null,
            subjectRefId: templateId,
            subjectLabel: label(template.name, actionName),
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
    return this.sealedTiers(templateId);
  },
};
