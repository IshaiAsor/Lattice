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

export interface UsageBucket {
  rows: number;
  bytes: number;
}

export interface UsageView {
  frames: UsageBucket;
  readings: UsageBucket;
  commands: UsageBucket;
  events: UsageBucket;
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
