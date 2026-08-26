import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

// The retention audit trail (F18.19) — every configuration change and every sweep, in one timeline.
//
// The runs page answers "what did the sweeps do". This answers the question that page could never
// reach: "who changed the policy, when, and from what". Until now nothing recorded that at all —
// a tier row's `updated_at` is current state, not history.

export type ActivityAction =
  | 'tiers_changed'
  | 'tiers_reset'
  | 'policy_changed'
  | 'bucket_created'
  | 'bucket_reused'
  | 'bucket_deleted'
  | 'sweep_requested'
  | 'sweep_finished'
  | 'sweep_failed'
  | 'data_trimmed';

export interface ActivityEntryView {
  id: number;
  at: string;
  action: ActivityAction;
  scope: 'platform' | 'user' | 'device' | 'action' | 'blueprint' | 'catalog';
  actorKind: 'user' | 'admin' | 'cron' | 'system';
  actorUserId: number | null;
  /** Never empty — a deleted actor still reads as "a deleted user" rather than a blank cell. */
  actorName: string;
  subjectUserId: number | null;
  subjectUserName: string | null;
  subjectRefId: number | null;
  /** The device / action / blueprint name AT THE TIME, so a rename does not rewrite history. */
  subjectLabel: string | null;
  dataKind: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  runId: number | null;
}

export interface ActivityPage {
  entries: ActivityEntryView[];
  /** Cursor, not an offset: the log only grows at the head, so an offset would re-show rows. */
  nextCursor: number | null;
}

@Injectable({ providedIn: 'root' })
export class RetentionActivityService {
  private http = inject(HttpClient);

  /** The signed-in user's own trail, plus platform-level entries that explain their windows. */
  mine(opts: { action?: string; kind?: string; before?: number } = {}): Observable<ActivityPage> {
    return this.http.get<ActivityPage>(`${apiUrl()}/api/retention/activity`, {
      params: this.params(opts),
    });
  }

  /** Everything, every scope, every user. */
  all(opts: { action?: string; kind?: string; before?: number } = {}): Observable<ActivityPage> {
    return this.http.get<ActivityPage>(`${apiUrl()}/api/admin/retention/activity`, {
      params: this.params(opts),
    });
  }

  private params(opts: { action?: string; kind?: string; before?: number }): HttpParams {
    let p = new HttpParams();
    if (opts.action) p = p.set('action', opts.action);
    if (opts.kind) p = p.set('kind', opts.kind);
    if (opts.before) p = p.set('before', String(opts.before));
    return p;
  }
}

/** What each action is called in the timeline, and which icon carries it. */
export const ACTION_META: Record<ActivityAction, { label: string; icon: string; tone: string }> = {
  tiers_changed: { label: 'Retention changed', icon: 'tune', tone: 'edit' },
  tiers_reset: { label: 'Reset to default', icon: 'restart_alt', tone: 'edit' },
  policy_changed: { label: 'Platform policy changed', icon: 'admin_panel_settings', tone: 'policy' },
  bucket_created: { label: 'Bucket size added', icon: 'add_circle', tone: 'add' },
  bucket_reused: { label: 'Existing size reused', icon: 'link', tone: 'muted' },
  bucket_deleted: { label: 'Bucket size removed', icon: 'remove_circle', tone: 'destructive' },
  sweep_requested: { label: 'Sweep requested', icon: 'play_circle', tone: 'muted' },
  sweep_finished: { label: 'Sweep completed', icon: 'check_circle', tone: 'ok' },
  sweep_failed: { label: 'Sweep failed', icon: 'error', tone: 'destructive' },
  data_trimmed: { label: 'Data trimmed', icon: 'content_cut', tone: 'destructive' },
};

/** Where it applied, in words. */
export const SCOPE_LABELS: Record<string, string> = {
  platform: 'Platform',
  user: 'User',
  device: 'Device',
  action: 'Sensor',
  blueprint: 'Blueprint',
  catalog: 'Bucket catalog',
};
