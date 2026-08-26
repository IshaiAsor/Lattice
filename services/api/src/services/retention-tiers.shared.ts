import {
  badRequest,
  isDataKind,
  assertTierList,
  diffTiers,
  summarizeTierChanges,
  type BucketDef,
  type DataKind,
  type PlatformTier,
  type Tier,
} from '@lattice/retention';
import { db } from '../db';
import { retentionActivityService, type ActivityScope } from './retention-activity.service';

// Shared internals for the retention services (F18.9-F18.19).
//
// This file was the top third of a 1,200-line retention-tiers.service.ts. The service split by
// concern - catalog, platform policy, the four stored scopes, blueprints, sweeps - and what is
// left here is the part every one of them needs: the catalog loader, the knobs, the parser, the
// validator, and the ONE audited tier write.
//
// `replaceTiers` staying single is the point rather than a side effect: it is the only path to a
// tier row, so a scope added later cannot write without an audit entry.
//
// Everything that decides WHICH rows exist lives in @lattice/retention; this file is the database
// and the transport around it. The split is not ceremony — the worker enforces the same rules, and
// Phase 1 had already grown a second copy of the clamp here "for display only", which is exactly
// how the two halves drift apart.

/** How far back the nightly rollup reads. The raw floor is derived from it. */
const LOOKBACK_DAYS = Number(process.env['RETENTION_LOOKBACK_DAYS'] ?? '3');

/** A vocabulary is not a scratch pad. Caps how many custom sizes can accumulate platform-wide. */
export const MAX_CUSTOM_BUCKETS = Number(process.env['RETENTION_MAX_CUSTOM_BUCKETS'] ?? '32');

/** What a data kind is called in a sentence, for the F18.16 notification. */
export const KIND_LABELS: Record<DataKind, string> = {
  scalar: 'sensor reading',
  frame: 'camera frame',
  command: 'command',
  device_event: 'device event',
};

export function assertKind(kind: string): asserts kind is DataKind {
  if (!isDataKind(kind)) throw badRequest(`Unknown data kind: ${kind}`);
}

export async function loadCatalog(): Promise<Map<string, BucketDef>> {
  const rows = await db.retentionBucket.findMany({ orderBy: { seconds: 'asc' } });
  return new Map(
    rows.map((r) => [
      r.code,
      {
        code: r.code,
        seconds: r.seconds,
        label: r.label,
        anchorOffsetSeconds: r.anchor_offset_seconds,
      },
    ]),
  );
}

interface PolicyKnobs {
  minBucket: string;
  enabled: boolean;
  ceilings: Map<string, number | null>;
  platform: PlatformTier[];
}

async function loadKnobs(kind: DataKind): Promise<PolicyKnobs> {
  const policy = await db.retentionPolicy.findUnique({
    where: { data_kind: kind },
    include: { tiers: true },
  });
  if (!policy) throw badRequest(`No retention policy for ${kind}`);
  return {
    minBucket: policy.min_bucket,
    enabled: policy.enabled,
    ceilings: new Map(policy.tiers.map((t) => [t.bucket, t.max_keep_days])),
    platform: policy.tiers.map((t) => ({
      bucket: t.bucket,
      keepDays: t.keep_days,
      maxKeepDays: t.max_keep_days,
      position: t.position,
    })),
  };
}

/** Parse a tier list off a request body. Shape only — the rules live in `assertTierList`. */
export function parseTiers(body: unknown): Tier[] {
  const raw = (body as { tiers?: unknown })?.tiers;
  if (!Array.isArray(raw)) throw badRequest('Expected a `tiers` array');
  return raw.map((t, i) => {
    const row = t as { bucket?: unknown; keepDays?: unknown; position?: unknown };
    if (typeof row.bucket !== 'string') throw badRequest(`Tier ${i} has no bucket`);
    const keepDays = Number(row.keepDays);
    if (!Number.isInteger(keepDays))
      throw badRequest(`Tier ${row.bucket} needs a whole number of days, or 0 for forever`);
    return {
      bucket: row.bucket,
      keepDays,
      position: Number.isInteger(row.position) ? Number(row.position) : i,
    };
  });
}

/** Validate a candidate list against the catalog, the knobs and the ceilings. */
export async function validate(
  kind: DataKind,
  tiers: Tier[],
  opts: { applyCeilings: boolean },
): Promise<void> {
  const [buckets, knobs] = await Promise.all([loadCatalog(), loadKnobs(kind)]);
  assertTierList(tiers, {
    kind,
    buckets,
    lookbackDays: LOOKBACK_DAYS,
    minBucket: knobs.minBucket,
    // F18.11: a user's write is refused against the ceiling rather than stored and quietly clamped
    // at prune time. The number shown has to be the number applied.
    ceilings: opts.applyCeilings ? knobs.ceilings : undefined,
  });
}

export const view = (t: { bucket: string; keep_days: number; position: number }) => ({
  bucket: t.bucket,
  keepDays: t.keep_days,
  position: t.position,
});

// ── The five scopes, as one shape ────────────────────────────────────────────
//
// Each scope is a different table (see prisma/SCHEMA.md for why it is five tables and not one with
// a nullable owner), but the read/replace/clear operations are identical, so they are expressed
// once here rather than five times.

/**
 * Replace a scope's whole list for one kind, in a transaction.
 *
 * Delete-then-insert rather than a diff, because **the whole list wins**: resolution takes the
 * entire list from the most specific scope that has any rows, so a partial write would not be a
 * smaller configuration, it would be a different one. Written out per scope rather than through a
 * table-name lookup — Prisma's delegates have different key shapes, and reaching for them by string
 * costs the type checking that catches exactly the mistake this function could make.
 */
/** Who is editing, and what the entry should say it was about. */
interface AuditContext {
  scope: ActivityScope;
  actorKind: 'user' | 'admin';
  actorUserId: number;
  subjectUserId: number | null;
  subjectRefId?: number | null;
  subjectLabel?: string | null;
}

/**
 * Replace one scope's tier list, and log what changed **in the same transaction**.
 *
 * One function for all four stored scopes rather than four near-identical ones. That is not only
 * de-duplication: it is what makes it impossible to add a scope later that silently writes without
 * an audit entry, because there is no other path to a tier write. The `before` list is read inside
 * the transaction, so the pair recorded is the pair that actually applied — reading it outside
 * would race another edit and log a diff that never happened.
 */
async function replaceTiers(
  where: Record<string, unknown>,
  create: (t: Tier) => Record<string, unknown>,
  model: 'userRetentionTier' | 'deviceRetentionTier' | 'actionRetentionTier',
  kind: DataKind,
  tiers: Tier[],
  audit: AuditContext,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const table = tx[model] as {
      findMany: (a: unknown) => Promise<{ bucket: string; keep_days: number; position: number }[]>;
      deleteMany: (a: unknown) => Promise<unknown>;
      createMany: (a: unknown) => Promise<unknown>;
    };
    const existing = await table.findMany({ where, orderBy: { position: 'asc' } });
    const before: Tier[] = existing.map((r) => ({
      bucket: r.bucket,
      keepDays: r.keep_days,
      position: r.position,
    }));

    await table.deleteMany({ where });
    if (tiers.length > 0) await table.createMany({ data: tiers.map(create) });

    const changes = diffTiers(before, tiers);
    if (changes.length > 0) {
      await retentionActivityService.record(
        {
          action: 'tiers_changed',
          scope: audit.scope,
          actorKind: audit.actorKind,
          actorUserId: audit.actorUserId,
          subjectUserId: audit.subjectUserId,
          subjectRefId: audit.subjectRefId ?? null,
          subjectLabel: audit.subjectLabel ?? null,
          dataKind: kind,
          summary: summarizeTierChanges(changes),
          before,
          after: tiers,
        },
        tx,
      );
    }
  });
}

export async function replaceUserTiers(
  userId: number,
  kind: DataKind,
  tiers: Tier[],
  audit: AuditContext,
): Promise<void> {
  await replaceTiers(
    { user_id: userId, data_kind: kind },
    (t) => ({
      user_id: userId,
      data_kind: kind,
      bucket: t.bucket,
      keep_days: t.keepDays,
      position: t.position,
    }),
    'userRetentionTier',
    kind,
    tiers,
    audit,
  );
}

export async function replaceDeviceTiers(
  deviceId: number,
  kind: DataKind,
  tiers: Tier[],
  audit: AuditContext,
): Promise<void> {
  await replaceTiers(
    { user_device_id: deviceId, data_kind: kind },
    (t) => ({
      user_device_id: deviceId,
      data_kind: kind,
      bucket: t.bucket,
      keep_days: t.keepDays,
      position: t.position,
    }),
    'deviceRetentionTier',
    kind,
    tiers,
    audit,
  );
}

export async function replaceActionTiers(
  actionId: number,
  kind: DataKind,
  tiers: Tier[],
  audit: AuditContext,
): Promise<void> {
  await replaceTiers(
    { user_device_action_id: actionId, data_kind: kind },
    (t) => ({
      user_device_action_id: actionId,
      data_kind: kind,
      bucket: t.bucket,
      keep_days: t.keepDays,
      position: t.position,
    }),
    'actionRetentionTier',
    kind,
    tiers,
    audit,
  );
}

/** A device's / action's name for the log, captured now so the entry survives a rename. */
export async function deviceLabel(deviceId: number): Promise<string | null> {
  const d = await db.userDevice.findUnique({ where: { id: deviceId }, select: { name: true } });
  return d?.name ?? null;
}

export async function actionLabel(actionId: number): Promise<string | null> {
  const a = await db.userDeviceAction.findUnique({
    where: { id: actionId },
    select: { action_name: true, user_device: { select: { name: true } } },
  });
  if (!a) return null;
  return a.user_device?.name ? `${a.user_device.name} · ${a.action_name}` : a.action_name;
}

/**
 * One catalog row as the API shape. Shared by `listBuckets` and BOTH create paths so a caller can
 * rely on the same fields whichever produced the object.
 */
export function bucketView(
  r: {
    code: string;
    seconds: number;
    label: string;
    anchor_offset_seconds: number;
    is_builtin: boolean;
    created_by_user_id: number | null;
    created_at: Date;
  },
  createdBy: string | null = null,
) {
  return {
    code: r.code,
    seconds: r.seconds,
    label: r.label,
    anchorOffsetSeconds: r.anchor_offset_seconds,
    isBuiltin: r.is_builtin,
    createdBy,
    createdByUserId: r.created_by_user_id,
    /** When it entered the catalog. The audit log holds the rest of its story. */
    createdAt: r.created_at.toISOString(),
    /**
     * Rows this size produces per sensor per day — the cost line the editor shows.
     *
     * Two decimals rather than whole rows: a weekly bucket is 0.14/day, and rounding that to 0
     * would present the cheapest size in the catalog as free.
     */
    rowsPerDay: r.seconds > 0 ? Math.round((86_400 / r.seconds) * 100) / 100 : null,
  };
}
