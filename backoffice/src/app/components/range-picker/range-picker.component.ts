import { Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  PRESET_LABELS,
  describeRange,
  type RangePreset,
  type RangeValue,
} from '../../services/history.service';

/**
 * Range picker: rolling presets plus an explicit from/to pair (F18.3).
 *
 * Stateless — it takes a value and emits a new one, so the same control serves the dashboard's
 * shared grid range and the two pages that keep a local one.
 *
 * The custom dates are native `<input type="date">` rather than a Material datepicker: the app
 * does not import MatDatepicker anywhere yet, and pulling in the module plus its date adapter to
 * put two dates in a menu is a lot of bundle for a control that a native input already renders
 * correctly (and, on a phone, better).
 */
@Component({
  selector: 'app-range-picker',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './range-picker.component.html',
  styleUrls: ['./range-picker.component.css'],
})
export class RangePickerComponent {
  value = input.required<RangeValue>();
  /** Shown on the trigger before the range summary, e.g. "Trend". */
  label = input<string>('');
  valueChange = output<RangeValue>();

  readonly presets: RangePreset[] = ['6h', '24h', '7d', '30d', '90d', '1y'];
  readonly labels = PRESET_LABELS;

  // Drafts, so typing a start date does not fire a request per keystroke with a half-built range.
  draftFrom = signal<string>('');
  draftTo = signal<string>('');

  summary = computed(() => describeRange(this.value()));
  isCustom = computed(() => this.value().preset === 'custom');

  /** Today, as the max any date input will accept — history cannot run forward. */
  readonly today = new Date().toISOString().slice(0, 10);

  pick(preset: RangePreset): void {
    this.valueChange.emit({ preset });
  }

  openCustom(): void {
    const v = this.value();
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    this.draftFrom.set(v.fromDate ?? week);
    this.draftTo.set(v.toDate ?? this.today);
  }

  onFrom(event: Event): void {
    this.draftFrom.set((event.target as HTMLInputElement).value);
  }

  onTo(event: Event): void {
    this.draftTo.set((event.target as HTMLInputElement).value);
  }

  applyCustom(): void {
    const from = this.draftFrom();
    const to = this.draftTo();
    if (!from && !to) return;
    this.valueChange.emit({
      preset: 'custom',
      ...(from ? { fromDate: from } : {}),
      ...(to ? { toDate: to } : {}),
    });
  }

  /** Blocks Apply on a range that would return nothing, rather than letting it look like no data. */
  customInvalid = computed(() => {
    const from = this.draftFrom();
    const to = this.draftTo();
    return !!from && !!to && from > to;
  });
}
