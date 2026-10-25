import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import {
  RetentionTiersService,
  bucketCost,
  ladderName,
  type ActionRetentionView,
  type BucketView,
} from '../../services/retention-tiers.service';
import { formatDays } from '../../services/retention.service';
import { ScopeLadderComponent } from '../scope-ladder/scope-ladder.component';
import { ScopeChipComponent } from '../scope-chip/scope-chip.component';

// "Data kept…" from a dashboard card (F18.20): what this sensor keeps, and who decided it. Read-only
// on purpose — editing lives on the device page's Data tab, and this links straight to the sensor's
// row there, so there is one place a list is changed rather than two that can disagree.

export interface SensorRetentionSheetData {
  deviceId: number;
  deviceName: string;
  actionId: number;
  actionName: string;
}

@Component({
  selector: 'app-sensor-retention-sheet',
  standalone: true,
  imports: [CommonModule, MatIconModule, ScopeLadderComponent, ScopeChipComponent],
  templateUrl: './sensor-retention-sheet.component.html',
  styleUrls: ['./sensor-retention-sheet.component.css'],
})
export class SensorRetentionSheetComponent {
  data: SensorRetentionSheetData = inject(MAT_BOTTOM_SHEET_DATA);
  private sheetRef = inject(MatBottomSheetRef<SensorRetentionSheetComponent>);
  private api = inject(RetentionTiersService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  action = signal<ActionRetentionView | null>(null);
  buckets = signal<BucketView[]>([]);
  failed = signal(false);

  readonly formatDays = formatDays;

  /** "Sealed template · Socket board" — the scope, and the named thing behind it where there is one. */
  decidedBy = computed(() => {
    const a = this.action();
    if (!a) return '';
    const s = a.effective.source;
    return (s === 'blueprint' || s === 'sealed') && a.effective.sourceLabel
      ? `${ladderName(s)} · ${a.effective.sourceLabel}`
      : ladderName(s);
  });

  constructor() {
    forkJoin({ view: this.api.deviceRetention(this.data.deviceId), buckets: this.api.buckets() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ view, buckets }) => {
          this.buckets.set(buckets);
          const a = view.actions.find((x) => x.actionId === this.data.actionId) ?? null;
          this.action.set(a);
          this.failed.set(a === null);
        },
        error: () => this.failed.set(true),
      });
  }

  bucketName(code: string): string {
    const b = this.buckets().find((x) => x.code === code);
    return b ? (b.seconds === 0 ? 'Raw' : b.label) : code;
  }

  costOf(code: string): string {
    const b = this.buckets().find((x) => x.code === code);
    return b ? (b.seconds === 0 ? 'every reading' : bucketCost(b)) : '';
  }

  storedIn(code: string): number {
    return this.action()?.stored?.buckets[code]?.rows ?? 0;
  }

  /** The device page's Data tab, with this sensor's row open — the one place lists are edited. */
  customise(openSensor = true): void {
    this.sheetRef.dismiss();
    void this.router.navigate(['/devices', this.data.deviceId], {
      queryParams: openSensor ? { tab: 'data', action: this.data.actionId } : { tab: 'data' },
    });
  }

  close(): void {
    this.sheetRef.dismiss();
  }
}
