import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

// Client for the F18 history API. Cold observables, thin methods, no caching layer — same shape as
// every other service here.

/** One point on a series. A raw point has count 1 and min === max === avg: a single reading has
 *  no spread, which is honest rather than missing. */
export interface SeriesPoint {
  t: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
  errors: number;
  last: string | null;
}

export interface SeriesView {
  /**
   * Which tier answered, as a `retention_buckets.code` — `raw`, `1h`, a custom `90m`, whatever is
   * configured. NOT a fixed union: the vocabulary is data (F18.9), so a closed type here would go
   * stale the first time anyone adds a size.
   */
  bucket: string;
  /** `fallback` means everything finer has been pruned past this range, not that the device was off. */
  reason: 'requested' | 'auto' | 'fallback';
  from: string;
  to: string;
  points: SeriesPoint[];
}

export interface CommandView {
  id: number;
  deviceId: number | null;
  deviceName: string | null;
  actionId: number | null;
  actionName: string;
  target: string;
  durationSeconds: number | null;
  source: string;
  sourceLabel: string | null;
  status: string;
  result: string | null;
  dispatchedAt: string;
  settledAt: string | null;
}

export interface CommandPage {
  commands: CommandView[];
  /** Cursor for the next page, or null at the end. Send back as `before`. */
  nextBefore: number | null;
}

export interface DeviceEventView {
  id: number;
  kind: string;
  from: string | null;
  to: string | null;
  detail: unknown;
  at: string;
}

export interface AvailabilityView {
  /** Null when nothing has been recorded — "we don't know yet" must not render as 0%. */
  uptimePercent: number | null;
  days: { day: string; onlineSeconds: number; offlineSeconds: number; transitions: number }[];
}

export interface FrameMetaView {
  id: number;
  bytes: number;
  capturedAt: string;
}

export interface FramePage {
  total: number;
  frames: FrameMetaView[];
}

export interface HistorySummary {
  commands: number;
  failed: number;
  devices: number;
  online: number;
}

/** The range chips the UI offers, as day counts. */
export type RangeKey = '24h' | '7d' | '30d';

export const RANGE_DAYS: Record<RangeKey, number> = { '24h': 1, '7d': 7, '30d': 30 };

/** `from` for a range key, relative to now. */
export function rangeFrom(key: RangeKey, now: Date = new Date()): string {
  return new Date(now.getTime() - RANGE_DAYS[key] * 86_400_000).toISOString();
}

// ── Chart range (F18.3) ──────────────────────────────────────────────────────
// A preset is a rolling window ("the last 7 days"); `custom` is a fixed pair of calendar dates.
// They are one type rather than two because every consumer wants the same thing out of it — a
// {from, to} to hand the API — and only the picker cares which kind it is.

export type RangePreset = '6h' | '24h' | '7d' | '30d' | '90d' | '1y' | 'custom';

export const PRESET_HOURS: Record<Exclude<RangePreset, 'custom'>, number> = {
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90,
  '1y': 24 * 365,
};

export const PRESET_LABELS: Record<RangePreset, string> = {
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
  custom: 'Custom',
};

export interface RangeValue {
  preset: RangePreset;
  /** `yyyy-MM-dd`, only meaningful when preset is `custom`. */
  fromDate?: string;
  toDate?: string;
}

export const DEFAULT_RANGE: RangeValue = { preset: '7d' };

/**
 * Turn a picker value into the ISO pair the API takes.
 *
 * `to` is left undefined for presets so the server sees "up to now" rather than a timestamp that
 * was already stale when the request left. For a custom range the end date is pushed to the END of
 * that day — a user picking 21–23 August means through the 23rd, not up to its first second.
 */
export function resolveRange(v: RangeValue, now: Date = new Date()): { from: string; to?: string } {
  if (v.preset !== 'custom') {
    return { from: new Date(now.getTime() - PRESET_HOURS[v.preset] * 3_600_000).toISOString() };
  }
  const from = v.fromDate ? new Date(`${v.fromDate}T00:00:00`) : new Date(now.getTime() - 7 * 86_400_000);
  const to = v.toDate ? new Date(`${v.toDate}T23:59:59.999`) : now;
  // A backwards range returns nothing and looks like "no data" rather than a mistake, so swap it.
  return from <= to
    ? { from: from.toISOString(), to: to.toISOString() }
    : { from: to.toISOString(), to: from.toISOString() };
}

/**
 * Is there anything a chart could actually draw?
 *
 * Point count is not the test. A command action can return buckets that carry a `count` but no
 * numeric average AND no usable `last` — an outlet whose only stored value is an empty string
 * produced exactly one such bucket, and the chart drew an empty 0–1 axis over it, which reads as
 * a broken chart rather than as "nothing here".
 */
export function hasPlottableData(points: SeriesPoint[]): boolean {
  return points.some((p) => p.avg !== null || (p.last !== null && p.last !== ''));
}

/** Human summary of a range, for the picker's trigger button. */
export function describeRange(v: RangeValue): string {
  if (v.preset !== 'custom') return PRESET_LABELS[v.preset];
  if (!v.fromDate && !v.toDate) return 'Custom';
  const fmt = (d?: string) => (d ? d.slice(5).replace('-', '/') : '…');
  return `${fmt(v.fromDate)} – ${fmt(v.toDate)}`;
}

@Injectable({ providedIn: 'root' })
export class HistoryService {
  private http = inject(HttpClient);
  private base = `${apiUrl()}/api/history`;

  summary(from?: string): Observable<HistorySummary> {
    return this.http.get<HistorySummary>(`${this.base}/summary`, { params: params({ from }) });
  }

  series(
    actionId: number,
    opts: { from?: string; to?: string; bucket?: string } = {},
  ): Observable<SeriesView> {
    return this.http.get<SeriesView>(`${this.base}/actions/${actionId}/series`, {
      params: params(opts),
    });
  }

  frames(
    actionId: number,
    opts: { from?: string; limit?: number; before?: number } = {},
  ): Observable<FramePage> {
    return this.http.get<FramePage>(`${this.base}/actions/${actionId}/frames`, {
      params: params(opts),
    });
  }

  /** One frame, fetched only when it is actually shown — the list carries metadata only. */
  frame(frameId: number): Observable<{ frame: string; capturedAt: string }> {
    return this.http.get<{ frame: string; capturedAt: string }>(`${this.base}/frames/${frameId}`);
  }

  deviceEvents(
    deviceId: number,
    opts: { from?: string; kind?: string; limit?: number } = {},
  ): Observable<DeviceEventView[]> {
    return this.http.get<DeviceEventView[]>(`${this.base}/devices/${deviceId}/events`, {
      params: params(opts),
    });
  }

  availability(deviceId: number, opts: { from?: string } = {}): Observable<AvailabilityView> {
    return this.http.get<AvailabilityView>(`${this.base}/devices/${deviceId}/availability`, {
      params: params(opts),
    });
  }

  commands(
    opts: {
      deviceId?: number;
      actionId?: number;
      source?: string;
      status?: string;
      from?: string;
      limit?: number;
      before?: number;
    } = {},
  ): Observable<CommandPage> {
    return this.http.get<CommandPage>(`${this.base}/commands`, { params: params(opts) });
  }
}

/** Drops undefined/empty so an unset filter never becomes `?source=undefined`. */
function params(obj: Record<string, unknown>): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    p = p.set(k, String(v));
  }
  return p;
}
