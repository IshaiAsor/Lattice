import { Component, DestroyRef, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RetentionTiersService, type RunView } from '../../services/retention-tiers.service';
import { formatBytes, type DataKind } from '../../services/retention.service';
import { RetentionActivityComponent } from '../retention-activity/retention-activity.component';

// Admin → Data Retention → Job history (F18.14).
//
// Modelled on the pipeline run history: a list of runs, each expandable to its per-kind breakdown.
// The point of it is the failures — a nightly pass that errored used to leave nothing behind but a
// log line in a container nobody tails, so "why is my history still growing" was unanswerable.
// A failed run shows its error inline here rather than vanishing.

const KIND_LABELS: Record<DataKind, string> = {
  scalar: 'Sensor readings',
  frame: 'Camera frames',
  command: 'Commands',
  device_event: 'Device events',
};

@Component({
  selector: 'app-admin-retention-runs',
  standalone: true,
  imports: [CommonModule, MatIconModule, RetentionActivityComponent],
  templateUrl: './admin-retention-runs.component.html',
  styleUrls: ['./admin-retention-runs.component.css'],
})
export class AdminRetentionRunsComponent {
  private api = inject(RetentionTiersService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly formatBytes = formatBytes;
  readonly kindLabels = KIND_LABELS;

  runs = signal<RunView[]>([]);
  loading = signal(true);
  expanded = signal<number | null>(null);

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api
      .adminRuns()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.runs.set(r);
          this.loading.set(false);
        },
        error: () => {
          this.snack.open('Could not load the job history', 'Dismiss', { duration: 4000 });
          this.loading.set(false);
        },
      });
  }

  toggle(id: number): void {
    this.expanded.update((cur) => (cur === id ? null : id));
  }

  duration(r: RunView): string {
    if (r.durationMs === null) return r.status === 'running' ? 'running…' : '—';
    if (r.durationMs < 1000) return `${r.durationMs} ms`;
    const s = r.durationMs / 1000;
    return s < 90 ? `${s.toFixed(1)}s` : `${Math.round(s / 60)}m ${Math.round(s % 60)}s`;
  }

  statusIcon(r: RunView): string {
    switch (r.status) {
      case 'ok':
        return 'check_circle';
      case 'failed':
        return 'error';
      case 'running':
        return 'autorenew';
      default:
        return 'schedule';
    }
  }

  triggerLabel(r: RunView): string {
    if (r.trigger === 'cron') return 'Nightly';
    if (r.trigger === 'admin') return 'Admin';
    return 'User';
  }

  /** Rows the run actually touched, so an expanded panel is not four zeros. */
  activeKinds(r: RunView) {
    return r.kinds.filter((k) => k.rowsDeleted > 0 || k.bucketsWritten > 0);
  }
}
