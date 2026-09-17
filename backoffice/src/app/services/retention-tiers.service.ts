import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';
import type { DataKind } from './retention.service';

// Client for the F18 Phase 2 tier API. Cold observables, thin methods, no caching layer — the same
// shape as every other service here.

/** One row of the shared bucket catalog. Any user may add a size; nobody may remove a builtin. */
export interface BucketView {
  code: string;
  seconds: number;
  label: string;
  anchorOffsetSeconds: number;
  isBuiltin: boolean;
  createdBy: string | null;
  createdByUserId: number | null;
  /** Rows this size produces per sensor per day — the cost line the editor shows. */
  rowsPerDay: number | null;
}

/** One tier of a list. `keepDays` of 0 means forever. */
export interface TierView {
  bucket: string;
  keepDays: number;
  position: number;
}

/** A tier once resolved, carrying the catalog facts the editor needs to price and floor it. */
export interface ResolvedTierView extends TierView {
  seconds: number;
  anchorOffsetSeconds: number;
}

/** A tier the server refused, with the rule that refused it — shown inline rather than swallowed. */
export interface RejectedTierView {
  bucket: string;
  reason: string;
}

/** Which scope supplied the list. The whole list wins from the most specific one that has any. */
export type TierScope = 'action' | 'device' | 'blueprint' | 'sealed' | 'user' | 'platform';

/**
 * One tier of a sealed template entry's list (F18.21). A template carries one list per
 * (entry, kind); the entry is addressed by its `mqtt_action_name`.
 */
export interface SealedTierView extends TierView {
  actionName: string;
  dataKind: DataKind;
}

export interface MyTiersView {
  dataKind: DataKind;
  /** Row PRESENCE, not a value comparison — see the API comment. */
  overridden: boolean;
  enabled: boolean;
  minBucket: string;
  platformTiers: (TierView & { maxKeepDays: number | null })[];
  tiers: ResolvedTierView[];
  source: TierScope;
  rejected: RejectedTierView[];
}

export interface PolicyTiersView {
  dataKind: DataKind;
  enabled: boolean;
  minBucket: string;
  updatedAt: string;
  tiers: (TierView & { maxKeepDays: number | null })[];
}

export interface RunKindView {
  dataKind: DataKind;
  bucketsWritten: number;
  rowsDeleted: number;
  bytesReclaimed: number;
  /** False only for frames, where byte_size is summed off the rows before deleting them. */
  bytesEstimated: boolean;
}

export interface RunView {
  id: number;
  /**
   * `rollup` is an interval pass (F18.17) — buckets built, nothing deleted; `catchup` is the
   * nightly full pass run late because the worker was down when it was due.
   */
  /** WHY the run exists. `rollup` appears only on rows written before F18.18 split the two axes. */
  trigger: 'cron' | 'catchup' | 'rollup' | 'admin' | 'user';
  /** WHICH of the four jobs it performed; `full` is all of them. */
  job: 'full' | 'build' | 'sweep' | 'delete' | 'orphan';
  status: 'queued' | 'running' | 'ok' | 'failed';
  phase: string | null;
  scoped: boolean;
  requestedBy: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  kinds: RunKindView[];
  rowsDeleted: number;
  bytesReclaimed: number;
}

/**
 * One retention job's schedule (F18.18).
 *
 * Four of them, because the pass turned out not to be one pass: building summaries, deleting old
 * readings, deleting old summaries and cleaning up after a removed tier have different costs and
 * want different hours.
 */
export interface JobScheduleView {
  job: 'bucket_build' | 'data_sweep' | 'bucket_delete' | 'orphan_sweep';
  title: string;
  /** One line on what this job actually touches — the names alone do not tell you. */
  blurb: string;
  /** Null on the build job means "follow the tier lists", which is the default. */
  cron: string | null;
  timezone: string;
  enabled: boolean;
  derived: boolean;
  /** The schedule in plain language, already formatted by the server. */
  label: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** Already formatted in this schedule's own zone, so the row does not mix two clocks. */
  lastRunLabel: string | null;
  nextRunLabel: string | null;
  /** The frequency floor this job is held to — build is cheap, the other three delete. */
  minIntervalSeconds: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * When each job runs (F18.17 / F18.18).
 *
 * The build cadence is still DERIVED from the finest configured tier by default, so this is the only
 * place an admin can see that adding a `15m` tier moved it. The other three carry a schedule an
 * admin sets here rather than in an env var.
 */
export interface ScheduleView {
  jobs: JobScheduleView[];
  /** Null when nothing sub-daily is configured and the daily pass is the whole schedule. */
  rollupIntervalSeconds: number | null;
  finestBucket: { code: string; label: string } | null;
  fallbackCron: string;
}

export interface PreviewView {
  rows: Record<DataKind, number>;
  bytes: Record<DataKind, number>;
  bytesEstimated: Record<DataKind, boolean>;
}

@Injectable({ providedIn: 'root' })
export class RetentionTiersService {
  private http = inject(HttpClient);
  private base = `${apiUrl()}/api/retention`;
  private admin = `${apiUrl()}/api/admin/retention`;

  // ── Catalog ───────────────────────────────────────────────────────────────

  buckets(): Observable<BucketView[]> {
    return this.http.get<BucketView[]>(`${this.base}/buckets`);
  }

  /** A size that already exists resolves to the existing row rather than erroring. */
  createBucket(seconds: number, label?: string): Observable<BucketView> {
    return this.http.post<BucketView>(`${this.base}/buckets`, { seconds, label });
  }

  // ── My tiers ──────────────────────────────────────────────────────────────

  mine(): Observable<MyTiersView[]> {
    return this.http.get<MyTiersView[]>(this.base);
  }

  setMine(kind: DataKind, tiers: TierView[]): Observable<MyTiersView[]> {
    return this.http.put<MyTiersView[]>(`${this.base}/${kind}`, { tiers });
  }

  /** Reset DELETES the rows, so the user follows future platform changes too. */
  resetMine(kind: DataKind): Observable<MyTiersView[]> {
    return this.http.delete<MyTiersView[]>(`${this.base}/${kind}`);
  }

  // ── Sweeps ────────────────────────────────────────────────────────────────

  preview(): Observable<PreviewView> {
    return this.http.get<PreviewView>(`${this.base}/preview`);
  }

  apply(): Observable<RunView> {
    return this.http.post<RunView>(`${this.base}/apply`, {});
  }

  myRun(id: number): Observable<RunView> {
    return this.http.get<RunView>(`${this.base}/runs/${id}`);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  policyTiers(): Observable<PolicyTiersView[]> {
    return this.http.get<PolicyTiersView[]>(this.admin);
  }

  setPolicyTiers(
    kind: DataKind,
    body: {
      tiers: (TierView & { maxKeepDays?: number | null })[];
      enabled?: boolean;
      minBucket?: string;
    },
  ): Observable<{ policies: PolicyTiersView[]; affected: { userId: number }[] }> {
    return this.http.put<{ policies: PolicyTiersView[]; affected: { userId: number }[] }>(
      `${this.admin}/${kind}`,
      body,
    );
  }

  adminPreview(): Observable<PreviewView> {
    return this.http.get<PreviewView>(`${this.admin}/preview`);
  }

  adminApply(): Observable<RunView> {
    return this.http.post<RunView>(`${this.admin}/apply`, {});
  }

  /** Routine (successful) interval rollups are hidden server-side unless asked for. */
  adminRuns(includeRollups = false): Observable<RunView[]> {
    const query = includeRollups ? '?rollups=true' : '';
    return this.http.get<RunView[]>(`${this.admin}/runs${query}`);
  }

  adminSchedule(): Observable<ScheduleView> {
    return this.http.get<ScheduleView>(`${this.admin}/schedule`);
  }

  setAdminSchedule(
    job: string,
    body: { cron: string | null; timezone?: string; enabled?: boolean },
  ): Observable<ScheduleView> {
    return this.http.put<ScheduleView>(`${this.admin}/schedule/${job}`, body);
  }

  adminRun(id: number): Observable<RunView> {
    return this.http.get<RunView>(`${this.admin}/runs/${id}`);
  }

  // ── Sealed templates (F18.21) ─────────────────────────────────────────────

  /** Every list a sealed template carries, one row per tier. */
  sealedTiers(templateId: number): Observable<SealedTierView[]> {
    return this.http.get<SealedTierView[]>(`${this.admin}/sealed/${templateId}`);
  }

  /** Applies immediately — tier lists are not part of a template's draft/release cycle. */
  setSealedTiers(
    templateId: number,
    actionName: string,
    kind: DataKind,
    tiers: TierView[],
  ): Observable<SealedTierView[]> {
    return this.http.put<SealedTierView[]>(
      `${this.admin}/sealed/${templateId}/${encodeURIComponent(actionName)}/${kind}`,
      { tiers },
    );
  }

  /** Deletes the entry's list, so its devices fall back to the wider scope. */
  clearSealedTiers(
    templateId: number,
    actionName: string,
    kind: DataKind,
  ): Observable<SealedTierView[]> {
    return this.http.delete<SealedTierView[]>(
      `${this.admin}/sealed/${templateId}/${encodeURIComponent(actionName)}/${kind}`,
    );
  }
}

/** A bucket code as a duration a human reads, for a select option. */
export function bucketLabel(b: BucketView): string {
  return b.seconds === 0 ? 'Raw readings' : b.label;
}

/** The cost line: how many rollup rows this size costs per sensor per day. */
export function bucketCost(b: BucketView): string {
  if (b.rowsPerDay === null) return 'one row per reading';
  if (b.rowsPerDay < 1) return `~${Math.round(1 / b.rowsPerDay)} days per row`;
  return `${b.rowsPerDay} rows per sensor per day`;
}

/** A duration in seconds → the boundaries it produces, for the custom-size preview. */
export function boundaryPreview(seconds: number, count = 4): string {
  if (seconds <= 0 || 86_400 % seconds !== 0) return '';
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const total = i * seconds;
    const h = Math.floor(total / 3600) % 24;
    const m = Math.floor((total % 3600) / 60);
    out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return `${out.join(', ')} …`;
}
