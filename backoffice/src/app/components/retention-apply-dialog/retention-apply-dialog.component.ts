import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { interval, switchMap, takeWhile } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  RetentionTiersService,
  type PreviewView,
  type RunView,
} from '../../services/retention-tiers.service';
import { formatBytes, type DataKind } from '../../services/retention.service';

// "Clean up now" — the confirmation, then the progress (F18.13/F18.15).
//
// Two things this refuses to do. It does not say "this may delete a lot of data": it counts, and
// names the number, because "irreversible" above a spinner teaches people to click through it. And
// it does not turn a 409 into a generic toast: a refused press means someone else's sweep is
// running, and saying whose and since when is the difference between "try again" and "wait".

export interface ApplyDialogData {
  /** Admin sweeps cover every user; a user sweep covers only their own rows. */
  scope: 'admin' | 'user';
}

const KIND_LABELS: Record<DataKind, string> = {
  scalar: 'sensor readings',
  frame: 'camera frames',
  command: 'commands',
  device_event: 'device events',
};

@Component({
  selector: 'app-retention-apply-dialog',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatDialogModule],
  templateUrl: './retention-apply-dialog.component.html',
  styleUrls: ['./retention-apply-dialog.component.css'],
})
export class RetentionApplyDialogComponent {
  private api = inject(RetentionTiersService);
  private ref = inject(MatDialogRef<RetentionApplyDialogComponent>);
  private destroyRef = inject(DestroyRef);
  readonly data = inject<ApplyDialogData>(MAT_DIALOG_DATA);

  readonly formatBytes = formatBytes;
  readonly kindLabels = KIND_LABELS;

  preview = signal<PreviewView | null>(null);
  loading = signal(true);
  run = signal<RunView | null>(null);
  error = signal<string | null>(null);
  starting = signal(false);

  /** Only the kinds with something to delete — a list of four zeros says nothing. */
  lines = computed(() => {
    const p = this.preview();
    if (!p) return [];
    return (Object.keys(p.rows) as DataKind[])
      .filter((k) => p.rows[k] > 0)
      .map((k) => ({
        kind: k,
        label: KIND_LABELS[k],
        rows: p.rows[k],
        bytes: p.bytes[k],
        estimated: p.bytesEstimated[k],
      }));
  });

  totalRows = computed(() => this.lines().reduce((n, l) => n + l.rows, 0));
  totalBytes = computed(() => this.lines().reduce((n, l) => n + l.bytes, 0));

  /** True once the run reaches a terminal state, so the dialog can offer Close rather than Cancel. */
  done = computed(() => {
    const r = this.run();
    return r !== null && (r.status === 'ok' || r.status === 'failed');
  });

  /**
   * The pass, as the four stages it actually runs.
   *
   * The worker writes `phase` before each stage starts — `rollup:scalar`, `rollup:command`,
   * `rollup:device_event`, `prune`, in that fixed order — so the progress here is the real thing
   * rather than a spinner pretending. It is also why these are hard-coded and not derived: the
   * order is the pass's own, and roll-up MUST precede prune or buckets are built from rows that
   * have already been deleted.
   */
  readonly steps = [
    { phase: 'rollup:scalar', label: 'Summarising sensor readings' },
    { phase: 'rollup:command', label: 'Summarising commands' },
    { phase: 'rollup:device_event', label: 'Summarising device activity' },
    { phase: 'prune', label: 'Removing expired rows' },
  ] as const;

  /** Where the run is in that list. `-1` while it is still queued and no stage has begun. */
  private stepIndex = computed(() => {
    const p = this.run()?.phase ?? null;
    return p === null ? -1 : this.steps.findIndex((s) => s.phase === p);
  });

  stepState(index: number): 'done' | 'active' | 'failed' | 'pending' {
    const r = this.run();
    if (!r) return 'pending';
    if (r.status === 'ok') return 'done';
    const at = this.stepIndex();
    if (r.status === 'failed') {
      if (at === -1) return 'pending';
      return index < at ? 'done' : index === at ? 'failed' : 'pending';
    }
    if (at === -1) return 'pending';
    return index < at ? 'done' : index === at ? 'active' : 'pending';
  }

  /**
   * The one line above the stages, for the states the stage list cannot express.
   *
   * `queued` is its own state and says so: the request is accepted but the worker has not picked it
   * up, which is different from "starting" and is exactly what someone sees if the worker is down.
   * While running, this is deliberately unused — the stage list already names the active stage, and
   * printing it here too said the same sentence twice.
   */
  headline(): string {
    const r = this.run();
    if (!r) return '';
    if (r.status === 'ok') return 'Finished';
    if (r.status === 'failed') return 'Failed';
    if (r.status === 'queued') return 'Waiting for the worker';
    const at = this.stepIndex();
    return at >= 0 ? this.steps[at]!.label : 'Starting';
  }

  constructor() {
    const source = this.data.scope === 'admin' ? this.api.adminPreview() : this.api.preview();
    source.pipe(takeUntilDestroyed()).subscribe({
      next: (p) => {
        this.preview.set(p);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not work out what would be removed.');
        this.loading.set(false);
      },
    });
  }

  start(): void {
    if (this.starting()) return;
    this.starting.set(true);
    this.error.set(null);
    const call = this.data.scope === 'admin' ? this.api.adminApply() : this.api.apply();
    call.subscribe({
      next: (r) => {
        this.run.set(r);
        this.poll(r.id);
      },
      error: (e: { status?: number; error?: { error?: string } }) => {
        this.starting.set(false);
        // A 409 is not a failure to report generically: it names the sweep already running, and
        // that message is the useful part.
        this.error.set(
          e.error?.error ??
            (e.status === 409
              ? 'Another cleanup is already running.'
              : 'Could not start the cleanup.'),
        );
      },
    });
  }

  /**
   * Poll while the run is live.
   *
   * Polling rather than a socket event: this is a screen two people look at, a new entry in the
   * event contract is not free, and re-reading one row every two seconds costs nothing.
   */
  private poll(id: number): void {
    const read = () => (this.data.scope === 'admin' ? this.api.adminRun(id) : this.api.myRun(id));
    interval(2000)
      .pipe(
        switchMap(read),
        takeWhile((r) => r.status === 'queued' || r.status === 'running', true),
        // The DestroyRef is passed EXPLICITLY. `takeUntilDestroyed()` with no argument may only be
        // called in an injection context, and this runs from inside `start()`'s subscribe callback
        // — where it throws, the polling subscription is never created, and the dialog sits on
        // "Waiting for the worker" for the life of the run while the sweep quietly finishes.
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (r) => this.run.set(r),
        error: () => this.error.set('Lost track of the cleanup — check the job history.'),
      });
  }

  close(): void {
    this.ref.close(this.run());
  }
}
