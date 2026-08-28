import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

// Storage usage, and the two formatters both retention screens share.
//
// This used to be the whole Phase 1 retention client — a user's per-kind windows, the platform
// defaults and ceilings, and the admin "overridden by" table. F18.9 replaced all of that with the
// tier lists in `RetentionTiersService`, and the old methods sat here calling endpoints that no
// component had used since. They are gone; what stayed is the part the tier work never replaced.
//
// `DataKind` lives here rather than in the tiers client because it is the vocabulary both use.

export type DataKind = 'scalar' | 'frame' | 'command' | 'device_event';

/** One bucket's contribution: `raw` for the source table, a catalog code for each rollup tier. */
export interface UsageBucket {
  rows: number;
  bytes: number;
  /** False only for camera frames, where `byte_size` is recorded at write time. */
  estimated: boolean;
}

export interface KindUsage extends UsageBucket {
  /**
   * Keyed by `retention_buckets.code`, always including `raw`. The totals above are their sum
   * (F18.22) — before that they were the RAW table alone, so every row retention itself creates
   * was missing from the figure retention is judged by.
   */
  buckets: Record<string, UsageBucket>;
}

export interface UsageView {
  frames: KindUsage;
  readings: KindUsage;
  commands: KindUsage;
  events: KindUsage;
}

/** The API key a data kind's usage lands under. */
const USAGE_KEY: Record<DataKind, keyof UsageView> = {
  scalar: 'readings',
  frame: 'frames',
  command: 'commands',
  device_event: 'events',
};

/**
 * One kind's usage, or an empty shell.
 *
 * Both retention screens do this lookup, and both used to do it with their own inline switch —
 * which is how the admin page and Settings end up disagreeing about what "Sensor readings" counts.
 */
export function usageForKind(usage: UsageView | null, kind: DataKind): KindUsage {
  return usage?.[USAGE_KEY[kind]] ?? { rows: 0, bytes: 0, estimated: true, buckets: {} };
}

@Injectable({ providedIn: 'root' })
export class RetentionService {
  private http = inject(HttpClient);

  /** What this user is storing. */
  myUsage(): Observable<UsageView> {
    return this.http.get<UsageView>(`${apiUrl()}/api/retention/usage`);
  }

  /** What everyone is storing. Admin only, enforced server-side. */
  platformUsage(): Observable<UsageView> {
    return this.http.get<UsageView>(`${apiUrl()}/api/admin/retention/usage`);
  }
}

/** Bytes → a short human string. Shared by both retention screens. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** `0` means forever everywhere in this feature — never "delete immediately". */
export function formatDays(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'Forever';
  if (days % 365 === 0) return `${days / 365} year${days === 365 ? '' : 's'}`;
  return `${days} day${days === 1 ? '' : 's'}`;
}
