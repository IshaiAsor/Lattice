import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

// Retention config, both layers (F18 Step 2).

export type DataKind = 'scalar' | 'frame' | 'command' | 'device_event';

/** The signed-in user's own window per kind, with what the platform would give them. */
export interface MyRetentionView {
  dataKind: DataKind;
  /** True when an override ROW exists — not a value comparison. Someone who deliberately chose
   *  14 while the default is also 14 has still chosen, and must not move when the default does. */
  overridden: boolean;
  rawDays: number;
  hourlyDays: number | null;
  dailyDays: number | null;
  defaultRawDays: number;
  maxRawDays: number | null;
  /** What the nightly job will actually apply after the ceiling. */
  effectiveRawDays: number | null;
  enabled: boolean;
}

/** The platform layer: the default everyone starts on plus the ceiling nobody may exceed. */
export interface RetentionPolicyView {
  dataKind: DataKind;
  defaultRawDays: number;
  defaultHourlyDays: number | null;
  defaultDailyDays: number | null;
  maxRawDays: number | null;
  maxHourlyDays: number | null;
  maxDailyDays: number | null;
  enabled: boolean;
  updatedAt: string;
}

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

export interface OverrideView {
  userId: number;
  userName: string;
  dataKind: DataKind;
  rawDays: number;
  hourlyDays: number | null;
  dailyDays: number | null;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class RetentionService {
  private http = inject(HttpClient);
  private mineBase = `${apiUrl()}/api/retention`;
  private adminBase = `${apiUrl()}/api/admin/retention`;

  mine(): Observable<MyRetentionView[]> {
    return this.http.get<MyRetentionView[]>(this.mineBase);
  }

  myUsage(): Observable<UsageView> {
    return this.http.get<UsageView>(`${this.mineBase}/usage`);
  }

  setMine(kind: DataKind, body: { rawDays?: number }): Observable<MyRetentionView[]> {
    return this.http.put<MyRetentionView[]>(`${this.mineBase}/${kind}`, body);
  }

  /** Reset DELETES the override row, so the user follows future default changes too. */
  resetMine(kind: DataKind): Observable<MyRetentionView[]> {
    return this.http.delete<MyRetentionView[]>(`${this.mineBase}/${kind}`);
  }

  policies(): Observable<RetentionPolicyView[]> {
    return this.http.get<RetentionPolicyView[]>(this.adminBase);
  }

  platformUsage(): Observable<UsageView> {
    return this.http.get<UsageView>(`${this.adminBase}/usage`);
  }

  overrides(): Observable<OverrideView[]> {
    return this.http.get<OverrideView[]>(`${this.adminBase}/overrides`);
  }

  updatePolicy(
    kind: DataKind,
    body: Partial<Record<string, number | boolean | null>>,
  ): Observable<RetentionPolicyView[]> {
    return this.http.put<RetentionPolicyView[]>(`${this.adminBase}/${kind}`, body);
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
  return `${days} days`;
}
