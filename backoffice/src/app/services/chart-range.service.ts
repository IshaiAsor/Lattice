import { Injectable, effect, signal } from '@angular/core';
import { DEFAULT_RANGE, type RangeValue, type RangePreset } from './history.service';

/**
 * The date range every dashboard tile's trend is drawn over (F18.3).
 *
 * Shared rather than per-tile on purpose: thirty sparklines each on their own window would be
 * thirty different x-axes on one screen, so comparing two tiles would mean comparing two
 * differently-scaled pictures. One range for the grid means the tiles are readable against each
 * other, and it is what "choose the range the chart refers to" has to mean when there are thirty
 * charts.
 *
 * Charts that ARE the subject of their page (device health, the activity feed) keep their own
 * local range — there the range belongs to the one thing on screen, not to a grid.
 */
@Injectable({ providedIn: 'root' })
export class ChartRangeService {
  private readonly KEY = 'lattice-chart-range';

  range = signal<RangeValue>(this.restore());

  constructor() {
    effect(() => {
      try {
        localStorage.setItem(this.KEY, JSON.stringify(this.range()));
      } catch {
        // A dashboard must render whether or not the preference survives.
      }
    });
  }

  set(v: RangeValue): void {
    this.range.set(v);
  }

  setPreset(preset: RangePreset): void {
    this.range.set({ preset });
  }

  private restore(): RangeValue {
    let raw: string | null;
    try {
      raw = localStorage.getItem(this.KEY);
    } catch {
      return { ...DEFAULT_RANGE };
    }
    if (!raw) return { ...DEFAULT_RANGE };
    try {
      const parsed = JSON.parse(raw) as Partial<RangeValue>;
      // Trust nothing from storage: an old build's key could hold a preset this one dropped.
      const valid: RangePreset[] = ['6h', '24h', '7d', '30d', '90d', '1y', 'custom'];
      if (!parsed.preset || !valid.includes(parsed.preset)) return { ...DEFAULT_RANGE };
      return {
        preset: parsed.preset,
        ...(parsed.fromDate ? { fromDate: parsed.fromDate } : {}),
        ...(parsed.toDate ? { toDate: parsed.toDate } : {}),
      };
    } catch {
      return { ...DEFAULT_RANGE };
    }
  }
}
