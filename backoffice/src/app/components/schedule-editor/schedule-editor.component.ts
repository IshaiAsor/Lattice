import { Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import type { JobScheduleView } from '../../services/retention-tiers.service';

// One retention job's schedule, editable (F18.18).
//
// A raw cron box is a needless way to get "every 6 hours" wrong — the same call
// `admin-blueprints` already made for pipeline triggers. So the picker is plain language and the
// cron string stays the stored form; this only builds it and reads it back. "Custom expression"
// stays available for the cases the picker does not cover, and the server validates either way.
//
// The build job additionally has a mode the others do not: FOLLOW THE TIER LISTS, which is `cron`
// NULL and the default. That is F18.17's derived cadence — the interval comes from the finest
// bucket anyone has configured, so adding a `15m` tier moves the schedule with no redeploy. Pinning
// it is offered, but it should look like the deliberate choice it is rather than the starting point.

type Mode = 'derived' | 'minutes' | 'hours' | 'daily' | 'weekly' | 'monthly' | 'cron';

interface ModeOption {
  id: Mode;
  label: string;
}

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

/** Steps that divide their unit evenly, so every boundary lands at the same clock time. */
const MINUTE_STEPS = [5, 10, 15, 20, 30];
const HOUR_STEPS = [2, 3, 4, 6, 8, 12];

@Component({
  selector: 'app-schedule-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule],
  templateUrl: './schedule-editor.component.html',
  styleUrls: ['./schedule-editor.component.css'],
})
export class ScheduleEditorComponent {
  schedule = input.required<JobScheduleView>();
  /** Refusal from the server, rendered inline beside the control that caused it. */
  error = input<string | null>(null);
  saving = input<boolean>(false);

  changed = output<{ cron: string | null; timezone: string; enabled: boolean }>();

  readonly weekdays = WEEKDAYS;
  readonly minuteSteps = MINUTE_STEPS;
  readonly hourSteps = HOUR_STEPS;

  /** Open only when someone is actually editing — four expanded pickers is a wall of controls. */
  editing = signal(false);

  mode = signal<Mode>('daily');
  time = signal('03:00');
  everyMinutes = signal(15);
  everyHours = signal(6);
  weekday = signal(0);
  dayOfMonth = signal(1);
  expression = signal('0 0 3 * * *');
  timezone = signal('UTC');

  /** Zones the browser knows. The server checks it too — this only saves people typing one. */
  readonly zones: string[] = (() => {
    try {
      const supported = (
        Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
      ).supportedValuesOf?.('timeZone');
      if (supported?.length) return supported;
    } catch {
      /* older engines: fall through to the two that always matter */
    }
    return ['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone].filter(
      (z, i, a) => z && a.indexOf(z) === i,
    );
  })();

  /** The viewer's own zone, offered as the obvious choice for a quiet hour. */
  readonly localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  modes = computed<ModeOption[]>(() => {
    const base: ModeOption[] = [
      { id: 'minutes', label: 'Every N minutes' },
      { id: 'hours', label: 'Every N hours' },
      { id: 'daily', label: 'Every day at' },
      { id: 'weekly', label: 'Every week on' },
      { id: 'monthly', label: 'Every month on' },
      { id: 'cron', label: 'Custom expression' },
    ];
    return this.schedule().job === 'bucket_build'
      ? [{ id: 'derived', label: 'Follow the tier lists' }, ...base]
      : base;
  });

  /** Only the build job may leave its schedule to the tier lists — the others have nothing to derive from. */
  canDerive = computed(() => this.schedule().job === 'bucket_build');

  open(): void {
    this.load(this.schedule());
    this.editing.set(true);
  }

  cancel(): void {
    this.editing.set(false);
  }

  /** Read a stored expression back into the picker, falling back to the raw box. */
  private load(s: JobScheduleView): void {
    this.timezone.set(s.timezone);
    this.expression.set(s.cron ?? '0 0 3 * * *');

    if (s.cron === null) {
      this.mode.set('derived');
      return;
    }

    // Six fields, or five with an implied zero second — the same shape the server accepts.
    const parts = s.cron.trim().split(/\s+/);
    const six = parts.length === 5 ? ['0', ...parts] : parts;
    if (six.length !== 6) {
      this.mode.set('cron');
      return;
    }
    const [sec, min, hour, dom, mon, dow] = six as [string, string, string, string, string, string];
    const everyDate = dom === '*' && mon === '*';
    const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : null);
    const step = (v: string) => {
      const m = v.match(/^\*\/(\d+)$/);
      return m ? Number(m[1]) : null;
    };

    if (sec !== '0') {
      this.mode.set('cron');
      return;
    }

    const minuteStep = step(min);
    if (minuteStep && hour === '*' && everyDate && dow === '*') {
      this.mode.set('minutes');
      this.everyMinutes.set(minuteStep);
      return;
    }

    const m = num(min);
    const hourStep = step(hour);
    if (m !== null && hourStep && everyDate && dow === '*') {
      this.mode.set('hours');
      this.everyHours.set(hourStep);
      this.time.set(this.hhmm(0, m));
      return;
    }

    const h = num(hour);
    if (m !== null && h !== null) {
      this.time.set(this.hhmm(h, m));
      const d = num(dow);
      const dm = num(dom);
      if (everyDate && dow === '*') {
        this.mode.set('daily');
        return;
      }
      if (dom === '*' && mon === '*' && d !== null) {
        this.mode.set('weekly');
        this.weekday.set(d);
        return;
      }
      if (dm !== null && mon === '*' && dow === '*') {
        this.mode.set('monthly');
        this.dayOfMonth.set(dm);
        return;
      }
    }

    this.mode.set('cron');
  }

  private hhmm(h: number, m: number): string {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private parts(): { h: number; m: number } {
    const [h, m] = this.time().split(':');
    return { h: Number(h ?? 0) || 0, m: Number(m ?? 0) || 0 };
  }

  /** The expression the picker currently describes — the stored form, built rather than typed. */
  built = computed<string | null>(() => {
    const mode = this.mode();
    if (mode === 'derived') return null;
    if (mode === 'cron') return this.expression().trim();
    // Reading the signals through the computed keeps this reactive; `parts()` is a plain read.
    const [hh, mm] = this.time().split(':');
    const h = Number(hh ?? 0) || 0;
    const m = Number(mm ?? 0) || 0;
    switch (mode) {
      case 'minutes':
        return `0 */${this.everyMinutes()} * * * *`;
      case 'hours':
        return `0 ${m} */${this.everyHours()} * * *`;
      case 'weekly':
        return `0 ${m} ${h} * * ${this.weekday()}`;
      case 'monthly':
        return `0 ${m} ${h} ${this.dayOfMonth()} * *`;
      default:
        return `0 ${m} ${h} * * *`;
    }
  });

  save(): void {
    this.changed.emit({
      cron: this.built(),
      timezone: this.timezone(),
      enabled: this.schedule().enabled,
    });
  }

  toggleEnabled(): void {
    const s = this.schedule();
    this.changed.emit({ cron: s.cron, timezone: s.timezone, enabled: !s.enabled });
  }

  /** Used only to reassure that the picker built what was intended, before Save. */
  preview(): string {
    const b = this.built();
    return b === null ? 'Follows the tier lists' : b;
  }
}
