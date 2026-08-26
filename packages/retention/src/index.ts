// @lattice/retention — the pure retention core.
//
// Every decision about WHICH rows exist, for how long, and at what granularity lives here, with no
// database, no transport and no clock of its own. Both `services/api` (validation, selection,
// display) and `services/automation-worker` (rollup, prune) need this arithmetic, and
// docs/CONVENTIONS.md is explicit that logic used by two services belongs in a package rather than
// copied — Phase 1 had already grown a second copy of the clamp in the API "for display only",
// which is exactly how the two halves drift apart.

export { DATA_KINDS, isDataKind, RAW_SECONDS, RAW_BUCKET, type DataKind } from './kinds';

export {
  WEEK_ANCHOR_OFFSET_SECONDS,
  bucketStart,
  hourStart,
  dayStart,
  formatSeconds,
  describeSeconds,
  isBucketAdmissible,
  assertBucketAdmissible,
  allowedForKind,
  whyNotAllowedForKind,
  badRequest,
  type BucketDef,
} from './buckets';

export { rawFloorDays, clampKeepDays, pruneCutoff } from './windows';

export {
  TIER_SCOPES,
  resolveTiers,
  assertTierList,
  assertChainDivisible,
  type Tier,
  type PlatformTier,
  type TierScope,
  type RejectedTier,
  type ResolvedTier,
  type ResolvedTiers,
  type TierResolutionInput,
  type TierListValidation,
} from './tiers';

export {
  emptyBucket,
  foldReading,
  foldRollup,
  bucketAvg,
  type Bucket,
  type RollupRow,
} from './fold';

export {
  sweepLockKey,
  findSweepConflict,
  GLOBAL_LOCK_KEY,
  RETENTION_LOCK_ID,
  type ActiveSweep,
} from './sweeps';

export {
  MAX_POINTS,
  MIN_POINTS,
  ASSUMED_RAW_INTERVAL_SECONDS,
  selectTier,
  type TierSelection,
  type TierSelectionOptions,
} from './select';

export {
  formatKeep,
  formatCeiling,
  diffTiers,
  isDestructive,
  describeChange,
  summarizeTierChanges,
  summarizeCeilingChanges,
  ceilingLowered,
  type TierChange,
} from './activity';
