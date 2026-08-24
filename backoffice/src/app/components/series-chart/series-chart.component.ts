import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, registerables, type ChartConfiguration, type ChartOptions } from 'chart.js';
import { ThemeService } from '../../services/theme.service';
import { hasPlottableData, type SeriesPoint } from '../../services/history.service';

// Chart.js is registered once, here, rather than in every consumer — registering the same
// controllers repeatedly is harmless but makes it unclear who owns the dependency. This component
// is the ONLY place in the app that imports chart.js; everything else takes points and a colour.
Chart.register(...registerables);

/**
 * A history series as a line chart.
 *
 * Two things this has to handle that a plain wrapper would not:
 *
 * 1. THEMING. Chart.js paints to a canvas and cannot read CSS custom properties, so `var(--text)`
 *    means nothing to it. The tokens are resolved through getComputedStyle and re-resolved when
 *    ThemeService.theme flips — light/dark here is a `.dark-theme` class on <body>, which changes
 *    no DOM inside this component, so nothing would re-render on its own.
 *
 * 2. FAULTS. A fault reading has no value. Drawing it as 0 would put a cliff in the middle of a
 *    temperature chart; dropping it silently would hide that the sensor was failing. It is drawn
 *    as a point on a second dataset instead, sitting at the last known value.
 */
@Component({
  selector: 'app-series-chart',
  standalone: true,
  imports: [CommonModule, BaseChartDirective],
  template: `
    @if (!hasData()) {
      <div class="chart-empty">
        <span>No readings in this range</span>
      </div>
    } @else {
      <div class="chart-host" [style.height.px]="height()">
        <canvas
          baseChart
          type="line"
          [datasets]="config().datasets"
          [labels]="config().labels"
          [options]="options()"
        ></canvas>
      </div>
    }
  `,
  styles: [
    `
      .chart-host {
        position: relative;
        width: 100%;
      }
      .chart-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 96px;
        font-size: 12px;
        color: var(--text-muted);
      }
    `,
  ],
})
export class SeriesChartComponent {
  points = input.required<SeriesPoint[]>();
  /** A CSS custom property NAME (e.g. `--primary`), resolved against the live theme. */
  colorToken = input<string>('--primary');
  height = input<number>(150);
  /** Hidden axes for a sparkline-sized chart inside a tile. */
  compact = input<boolean>(false);
  unit = input<string>('');

  /** Drives the empty state — see hasPlottableData: a point is not the same as a value. */
  hasData = computed(() => hasPlottableData(this.points()));

  private theme = inject(ThemeService);
  // Bumped whenever the theme changes, purely to re-run the colour resolution below. The token
  // values live in CSS, so there is nothing to read until the class has actually been applied.
  private themeTick = signal(0);

  constructor() {
    effect(() => {
      this.theme.theme();
      this.themeTick.update((n) => n + 1);
    });
  }

  private css(token: string, fallback: string): string {
    this.themeTick();
    const v = getComputedStyle(document.body).getPropertyValue(token).trim();
    return v || fallback;
  }

  /**
   * State levels for a NON-NUMERIC series, or null when the series is numeric.
   *
   * An outlet's history is `'on'`/`'off'`, so every bucket has `avg === null` and the line chart
   * had nothing to draw — the tile rendered an empty plot with a meaningless 0–1 axis. The API
   * already returns each bucket's `last` value, so the states can be laid out as levels and drawn
   * as a step line: the shape of "when was it on" rather than an average of something that was
   * never a number.
   */
  private levels = computed<{ order: string[]; index: Map<string, number> } | null>(() => {
    const pts = this.points();
    if (pts.length === 0) return null;
    if (pts.some((p) => p.avg !== null)) return null;
    const seen = new Set<string>();
    for (const p of pts) if (p.last !== null && p.last !== '') seen.add(p.last);
    if (seen.size === 0) return null;
    // Off-like states sort to the bottom so a switch reads the way a square wave should, rather
    // than inverted by whichever value happened to arrive first.
    const OFF = ['off', 'unlock', 'disarm', 'close', 'closed', 'stop', 'false', '0'];
    const order = [...seen].sort((a, b) => {
      const ai = OFF.includes(a.toLowerCase()) ? 0 : 1;
      const bi = OFF.includes(b.toLowerCase()) ? 0 : 1;
      return ai !== bi ? ai - bi : a.localeCompare(b);
    });
    return { order, index: new Map(order.map((v, i) => [v, i])) };
  });

  /** True when the chart is drawing states rather than readings. */
  isStateSeries = computed(() => this.levels() !== null);

  config = computed<{ datasets: ChartConfiguration<'line'>['data']['datasets']; labels: string[] }>(
    () => {
      const pts = this.points();
      const levels = this.levels();
      const accent = this.css(this.colorToken(), '#4f46e5');
      const error = this.css('--error', '#ef5350');

      const labels = pts.map((p) => p.t);
      const values = levels
        ? pts.map((p) => (p.last ? (levels.index.get(p.last) ?? null) : null))
        : pts.map((p) => p.avg);

      // Faults ride a second dataset so they are visible without distorting the line. Positioned
      // at the last known value rather than at zero, so a marker sits where the reading would
      // have been instead of dragging the axis down.
      let lastKnown: number | null = null;
      const faults = pts.map((p) => {
        if (p.avg !== null) lastKnown = p.avg;
        return p.errors > 0 ? lastKnown : null;
      });
      const hasFaults = faults.some((f) => f !== null);

      const datasets: ChartConfiguration<'line'>['data']['datasets'] = [
        {
          data: values,
          borderColor: accent,
          backgroundColor: withAlpha(accent, 0.12),
          borderWidth: 1.9,
          pointRadius: 0,
          pointHoverRadius: 4,
          // A state holds until something changes it, so it steps — interpolating between `off`
          // and `on` would draw a ramp through values the device was never in.
          tension: levels ? 0 : 0.28,
          stepped: levels ? ('before' as const) : false,
          fill: true,
          // Leaves a visible break where data is genuinely missing rather than drawing a straight
          // line across a gap that never happened.
          spanGaps: false,
        },
      ];
      if (hasFaults) {
        datasets.push({
          data: faults,
          borderColor: 'transparent',
          backgroundColor: error,
          pointRadius: 3.2,
          pointHoverRadius: 5,
          showLine: false,
        });
      }
      return { datasets, labels };
    },
  );

  options = computed<ChartOptions<'line'>>(() => {
    const compact = this.compact();
    const levels = this.levels();
    const muted = this.css('--text-muted', '#6366a0');
    const dim = this.css('--text-dim', '#a5b4fc');
    const grid = withAlpha(this.css('--border-strong', 'rgba(99,102,241,.25)'), 0.5);
    const surface = this.css('--card-bg', '#fff');
    const text = this.css('--text', '#1e1b4b');
    const unit = this.unit();

    return {
      responsive: true,
      maintainAspectRatio: false,
      // The app runs zone-based change detection with no OnPush, and rules.component already
      // memoizes clock strings to dodge NG0100. Animation off keeps the canvas from redrawing on
      // every unrelated tick.
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: surface,
          titleColor: text,
          bodyColor: muted,
          borderColor: grid,
          borderWidth: 1,
          padding: 8,
          displayColors: false,
          callbacks: {
            title: (items) => formatStamp(items[0]?.label ?? ''),
            label: (item) => {
              const v = item.parsed.y;
              if (v === null || v === undefined) return 'no reading';
              // The y value is a level index for a state series — reporting "1" would be
              // meaningless, and worse, would look like a reading.
              if (levels) return levels.order[v] ?? String(v);
              return `${round(v)}${unit}`;
            },
          },
        },
      },
      scales: {
        x: {
          display: !compact,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: dim,
            font: { size: 9 },
            maxRotation: 0,
            autoSkipPadding: 24,
            callback(value) {
              const raw = this.getLabelForValue(Number(value));
              return formatTick(raw);
            },
          },
        },
        y: levels
          ? {
              display: !compact,
              grid: { color: grid },
              border: { display: false },
              // One tick per state, and no fractional ticks between them — half of `on` is not a
              // thing. The padding keeps the top and bottom lines off the plot edges.
              min: -0.15,
              max: levels.order.length - 1 + 0.15,
              ticks: {
                color: dim,
                font: { size: 9 },
                stepSize: 1,
                autoSkip: false,
                callback: (value) => levels.order[Number(value)] ?? '',
              },
            }
          : {
              display: !compact,
              grid: { color: grid },
              border: { display: false },
              ticks: { color: dim, font: { size: 9 }, maxTicksLimit: 4 },
            },
      },
    };
  });
}

function round(v: number): string {
  return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

function formatTick(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A theme token plus alpha.
 *
 * The tokens resolve to whatever CSS holds — `#4f46e5` in light, `#38bdf8` in dark, and
 * `rgba(...)` for the borders — so this has to cope with hex and rgb alike rather than assuming
 * one. `color-mix` would be neater but Chart.js hands these straight to the canvas, which does not
 * understand it.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!;
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = color.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const [r, g, b] = rgb[1]!.split(',').map((s) => parseFloat(s));
    return `rgba(${r ?? 0}, ${g ?? 0}, ${b ?? 0}, ${alpha})`;
  }
  return color;
}
