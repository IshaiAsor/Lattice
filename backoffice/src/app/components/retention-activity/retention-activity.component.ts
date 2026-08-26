import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  RetentionActivityService,
  ACTION_META,
  SCOPE_LABELS,
  type ActivityEntryView,
} from '../../services/retention-activity.service';
import { formatBytes } from '../../services/retention.service';

// The retention audit trail (F18.19), used at both scopes: the admin page shows everything, and
// Settings → Data & storage shows a user their own.
//
// One component rather than two, because the entry IS the same entry — what differs is only which
// rows the server returns, and that is a decision the server has to make anyway (a platform run's
// counters are everyone's data volumes). A second component would have been a second chance to get
// that filter wrong.

const KIND_LABELS: Record<string, string> = {
  scalar: 'Sensor readings',
  frame: 'Camera frames',
  command: 'Commands',
  device_event: 'Device events',
};

@Component({
  selector: 'app-retention-activity',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './retention-activity.component.html',
  styleUrls: ['./retention-activity.component.css'],
})
export class RetentionActivityComponent {
  private api = inject(RetentionActivityService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  /** `true` on the admin page — every scope and every user. */
  admin = input<boolean>(false);

  readonly meta = ACTION_META;
  readonly scopeLabels = SCOPE_LABELS;
  readonly kindLabels = KIND_LABELS;

  entries = signal<ActivityEntryView[]>([]);
  loading = signal(true);
  cursor = signal<number | null>(null);
  expanded = signal<number | null>(null);
  filter = signal<string>('');

  /** Only the actions actually present, so the filter never offers an empty result. */
  actions = computed(() => {
    const seen = new Set(this.entries().map((e) => e.action));
    return [...seen].map((a) => ({ value: a, label: ACTION_META[a]?.label ?? a }));
  });

  shown = computed(() => {
    const f = this.filter();
    return f ? this.entries().filter((e) => e.action === f) : this.entries();
  });

  constructor() {
    this.load();
  }

  load(append = false): void {
    this.loading.set(true);
    const opts = append && this.cursor() ? { before: this.cursor()! } : {};
    const req = this.admin() ? this.api.all(opts) : this.api.mine(opts);
    req.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => {
        this.entries.update((cur) => (append ? [...cur, ...page.entries] : page.entries));
        this.cursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: () => {
        this.snack.open('Could not load the activity log', 'Dismiss', { duration: 4000 });
        this.loading.set(false);
      },
    });
  }

  toggle(id: number): void {
    this.expanded.update((cur) => (cur === id ? null : id));
  }

  setFilter(value: string): void {
    this.filter.set(value);
  }

  /** "3 minutes ago" for the recent past, an absolute date once that stops being useful. */
  when(at: string): string {
    const then = new Date(at).getTime();
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
    if (mins < 60 * 24 * 7) return `${Math.floor(mins / 1440)}d ago`;
    return new Date(at).toLocaleDateString();
  }

  exact(at: string): string {
    return new Date(at).toLocaleString();
  }

  /** Who, phrased for the row. `cron` has no person behind it and must not read as though it did. */
  who(e: ActivityEntryView): string {
    if (e.actorKind === 'cron') return 'Nightly sweep';
    if (e.actorKind === 'system') return 'System';
    return e.actorName;
  }

  /**
   * What it applied to: the specific object where there is one, the scope otherwise.
   *
   * `user` scope contributes nothing — every entry in a feed is about a user, and the row already
   * ends with "for <name>", so printing the word "User" here only competes with the part that
   * carries information.
   */
  target(e: ActivityEntryView): string {
    const parts: string[] = [];
    if (e.subjectLabel) parts.push(e.subjectLabel);
    else if (e.scope !== 'user') parts.push(this.scopeLabels[e.scope] ?? e.scope);
    if (e.dataKind) parts.push(this.kindLabels[e.dataKind] ?? e.dataKind);
    return parts.join(' · ');
  }

  hasDetail(e: ActivityEntryView): boolean {
    return this.sections(e).length > 0;
  }

  /**
   * The detail, as something a person reads.
   *
   * This used to print `before` and `after` as raw JSON side by side, which answers a developer's
   * question ("what is in the column") and not the owner's ("what changed"). The pair is still
   * stored — it is the record — but here it is resolved into rows keyed by bucket, so an unchanged
   * window sits quiet and the one that moved is the thing you see.
   */
  sections(e: ActivityEntryView): Section[] {
    switch (e.action) {
      case 'tiers_changed':
      case 'tiers_reset':
        return diffSection('Retention windows', asTiers(e.before), asTiers(e.after));

      case 'policy_changed': {
        const b = asRecord(e.before);
        const a = asRecord(e.after);
        return [
          ...diffSection('Default windows', asTiers(b['tiers']), asTiers(a['tiers'])),
          ...ceilingSection(asRecord(b['ceilings']), asRecord(a['ceilings'])),
        ];
      }

      case 'data_trimmed': {
        const rows = asArray(e.before)
          .map(asRecord)
          .map((t) => ({
            label: String(t['bucket'] ?? '—'),
            before: keepLabel(t['from']),
            after: keepLabel(t['to']),
            state: 'changed' as const,
          }));
        return rows.length ? [{ title: 'Brought within the ceiling', kind: 'diff', rows }] : [];
      }

      case 'bucket_created':
      case 'bucket_reused':
      case 'bucket_deleted': {
        const src = asRecord(e.action === 'bucket_deleted' ? e.before : e.after);
        if (!src['code']) return [];
        const seconds = Number(src['seconds'] ?? 0);
        const gone = e.action === 'bucket_deleted';
        return [
          {
            title: 'Bucket size',
            kind: 'diff',
            rows: [
              {
                label: String(src['label'] ?? src['code']),
                before: gone ? durationLabel(seconds) : null,
                after: gone ? null : durationLabel(seconds),
                state: gone ? 'removed' : 'added',
              },
              {
                label: 'Rollup rows per sensor per day',
                before: null,
                after: seconds > 0 ? String(Math.round((86_400 / seconds) * 100) / 100) : '—',
                state: 'same',
              },
            ],
          },
        ];
      }

      case 'sweep_finished': {
        const counters = asRecord(e.after);
        const rows = Object.entries(counters)
          .map(([kind, v]) => {
            const c = asRecord(v);
            return {
              label: KIND_LABELS[kind] ?? kind,
              summarised: Number(c['bucketsWritten'] ?? 0),
              removed: Number(c['rowsDeleted'] ?? 0),
              // Stored as a string because it is a bigint — Number() here would silently lose
              // precision on a large sweep.
              bytes: Number(c['bytesReclaimed'] ?? 0),
              estimated: c['bytesEstimated'] !== false,
            };
          })
          .filter((r) => r.summarised > 0 || r.removed > 0);
        return rows.length ? [{ title: 'What the sweep did', kind: 'counters', rows }] : [];
      }

      default:
        return [];
    }
  }

  readonly formatBytes = formatBytes;
}

// ── Shaping the stored record into rows ──────────────────────────────────────
//
// Everything below is defensive by design: `before`/`after` are `unknown` because they are read
// back out of a JSONB column that has been written by more than one version of this feature. A
// history page that throws on an old row is worse than one that shows a dash.

export interface DiffRow {
  label: string;
  before: string | null;
  after: string | null;
  state: 'added' | 'removed' | 'changed' | 'same';
}

export interface CounterRow {
  label: string;
  summarised: number;
  removed: number;
  bytes: number;
  estimated: boolean;
}

export type Section =
  | { title: string; kind: 'diff'; rows: DiffRow[] }
  | { title: string; kind: 'counters'; rows: CounterRow[] };

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asTiers(v: unknown): { bucket: string; keepDays: number }[] {
  return asArray(v)
    .map(asRecord)
    .filter((t) => typeof t['bucket'] === 'string')
    .map((t) => ({ bucket: String(t['bucket']), keepDays: Number(t['keepDays'] ?? 0) }));
}

/** `0` is forever everywhere in this feature — never "delete immediately". */
function keepLabel(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return 'Forever';
  if (n % 365 === 0) return `${n / 365} year${n === 365 ? '' : 's'}`;
  return `${n} day${n === 1 ? '' : 's'}`;
}

/** `null` is uncapped — a different spelling from forever, and deliberately so. */
function ceilingLabel(v: unknown): string {
  return v === null || v === undefined ? 'No limit' : keepLabel(v);
}

function durationLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  return `${Math.round(seconds / 60)} minutes`;
}

/**
 * Rows keyed by bucket, union of both sides, coarsest last.
 *
 * Unchanged buckets are KEPT rather than filtered out: "raw is still 14 days" is the context that
 * makes "1d went to forever" legible. They are just styled quiet.
 */
function diffSection(
  title: string,
  before: { bucket: string; keepDays: number }[],
  after: { bucket: string; keepDays: number }[],
): Section[] {
  const b = new Map(before.map((t) => [t.bucket, t.keepDays]));
  const a = new Map(after.map((t) => [t.bucket, t.keepDays]));
  const buckets = [...new Set([...b.keys(), ...a.keys()])];
  if (buckets.length === 0) return [];

  const rows: DiffRow[] = buckets.map((bucket) => {
    const hadIt = b.has(bucket);
    const hasIt = a.has(bucket);
    return {
      label: bucket,
      before: hadIt ? keepLabel(b.get(bucket)) : null,
      after: hasIt ? keepLabel(a.get(bucket)) : null,
      state: !hadIt ? 'added' : !hasIt ? 'removed' : b.get(bucket) === a.get(bucket) ? 'same' : 'changed',
    };
  });
  return [{ title, kind: 'diff', rows }];
}

function ceilingSection(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Section[] {
  const buckets = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const rows: DiffRow[] = buckets
    .map((bucket) => ({
      label: bucket,
      before: ceilingLabel(before[bucket]),
      after: ceilingLabel(after[bucket]),
      state: (ceilingLabel(before[bucket]) === ceilingLabel(after[bucket])
        ? 'same'
        : 'changed') as DiffRow['state'],
    }))
    .filter((r) => r.state === 'changed');
  // Only the ceilings that MOVED: unlike a window, an unchanged ceiling is not context for
  // anything — the whole section exists to answer "what is everyone now capped at".
  return rows.length ? [{ title: 'Ceilings', kind: 'diff', rows }] : [];
}
