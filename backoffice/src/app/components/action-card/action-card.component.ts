import {
  Component,
  DestroyRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { CameraDisplayComponent } from '../camera-display/camera-display.component';
import { ReceivedBadgeComponent } from '../received-badge/received-badge.component';
import { SeriesChartComponent } from '../series-chart/series-chart.component';
import {
  HistoryService,
  hasPlottableData,
  resolveRange,
  type CommandView,
  type SeriesPoint,
} from 'src/app/services/history.service';
import { ChartRangeService } from 'src/app/services/chart-range.service';
import {
  TileDensityService,
  defaultFieldsFor,
  type Density,
} from 'src/app/services/tile-density.service';
import {
  activeTraitValue,
  controllableTraits,
  COLOR_OPTIONS,
  hasTrait,
  iconForAction,
  isCameraAction,
  isTelemetryAction,
  traitIconName,
} from 'src/app/utils/device-type.utils';

// Dial geometry
const CX = 60,
  CY = 52,
  R = 36;
const START_ANGLE = 225;
const TOTAL_SWEEP = 270;

function toSvgPt(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) };
}

/**
 * The single rendering of one device action: header, active-trait control, sensor read-outs,
 * camera frame and trait switcher. Used by the dashboard grid and by the group bottom sheet —
 * both had their own copy before, and the sheet's copy kept falling behind.
 *
 * The card fills whatever slot its owner lays out. The dashboard grid and the group sheet both
 * size their slots from the Display picker; the setup tile sizes its own (216x188) and therefore
 * pins `density` so a picker change cannot reflow a card inside a box that will not hold it.
 *
 * The card owns the *control* side (sending state, switching the default trait); live state
 * arrives by the owner mutating the `DeviceActionView` it passed in, which both owners already
 * do from their socket subscriptions.
 */
@Component({
  selector: 'app-action-card',
  standalone: true,
  imports: [SHARED_MATERIAL, CameraDisplayComponent, ReceivedBadgeComponent, SeriesChartComponent],
  templateUrl: './action-card.component.html',
  styleUrl: './action-card.component.css',
})
export class ActionCardComponent {
  private socketService = inject(DeviceSocketService);
  private userActionsService = inject(UserActionsService);
  private history = inject(HistoryService);
  private chartRange = inject(ChartRangeService);
  private tiles = inject(TileDensityService);

  /**
   * Pins the card to one shape instead of following the dashboard's Display picker.
   *
   * The picker is a *dashboard* preference. The group sheet follows it deliberately (a group card
   * is a dashboard card, and its slots read the same --tile-* tokens), but the setup tile renders
   * this card into fixed 216x188 slots on a page that never offered the picker — there, a List or
   * Detailed pick reflowed the card inside a box that cannot hold the new shape: names truncated
   * to two characters, a chart with no room, the last-command line over the read-outs.
   *
   * Passing a density opts out entirely: that shape, and that shape's default fields.
   */
  density = input<Density | null>(null);

  /**
   * What the card actually renders as — the pin above when there is one, the picker otherwise.
   * Stamped onto the card as `data-density` so the stylesheet can branch on it.
   *
   * NOT read from `:root[data-density]` in CSS: this component has emulated encapsulation, and a
   * rule anchored outside the component does not survive the shim — the list layout silently did
   * nothing until this was measured in a browser.
   */
  effectiveDensity = computed(() => this.density() ?? this.tiles.density());
  /** Field toggles follow the same source as the density: a pinned owner ignores the picker. */
  fields = computed(() => {
    const pinned = this.density();
    return pinned ? defaultFieldsFor(pinned) : this.tiles.fields();
  });
  private destroyRef = inject(DestroyRef);

  // ── History on the tile (F18.3 + F21.4) ───────────────────────────────────
  //
  // The tile body used to spend 88-92px on a dial that repeated the number printed beside it.
  // A sparkline is smaller AND says something the number cannot — which is what funds the
  // second line of name the redesign is really about.
  //
  // Fetched per card, once, and only when the current density actually renders it: a Compact
  // dashboard of thirty tiles must not fire thirty series requests for charts nobody can see.
  points = signal<SeriesPoint[]>([]);

  /** Whether this density + field selection wants a trend at all. */
  showTrend = computed(() => {
    const f = this.fields();
    return f.sparkline || f.chart;
  });

  /**
   * A full chart (axes and all) rather than a bare sparkline.
   *
   * Clamped to Detailed. An 84px chart cannot go in a 104px Compact tile or a 56px List row — the
   * sweep measured 36px and 26px of overflow when the field was switched on there. This is the
   * same rule the breakpoints already follow: the picker states a preference, the density decides
   * what fits, and the preference degrades to a sparkline rather than being ignored outright.
   */
  showChart = computed(() => this.fields().chart && this.effectiveDensity() === 'detailed');
  /** A trend slot is only worth its space if the series has something to draw in it. */
  hasTrendData = computed(() => hasPlottableData(this.points()));

  /**
   * Whether to lay the trend column out at all — which is not the same question as whether there
   * is anything to draw in it.
   *
   * A List is a table: the trailing cluster is right-aligned, so a row that skipped its trend
   * pulled its power button, last-command line and badge ~150px left of every neighbour that had
   * one. Two sockets of the same type visibly failed to line up. In List the slot is therefore
   * reserved whether or not the series has data; the tiled densities still collapse it, where an
   * always-empty box would only spend height they do not have.
   */
  showTrendSlot = computed(
    () => this.showTrend() && (this.hasTrendData() || this.effectiveDensity() === 'list'),
  );

  /** The `Last command` field toggle — until now a switch wired to nothing. */
  showLastCommand = computed(() => this.fields().lastCommand);
  lastCommand = signal<CommandView | null>(null);

  /**
   * Reserve the last-command cell, for the same reason the trend cell is reserved: in a List the
   * cluster is right-aligned, so a row whose action has never been commanded pulled everything to
   * its right across by the width of the cell it skipped.
   */
  showLastCmdSlot = computed(
    () =>
      this.showLastCommand() && (this.lastCommand() !== null || this.effectiveDensity() === 'list'),
  );

  /** Empty rather than absent when the slot is reserved but there is no command to describe. */
  lastCommandTitle = computed(() => {
    const c = this.lastCommand();
    return c ? `${c.sourceLabel || c.source} → ${c.target}` : '';
  });

  /**
   * Sparkline height by density. Passed as a number because Chart.js sizes the canvas, not CSS —
   * at Compact the 30px default plus the read-out overflowed a ~46px body and the values were
   * clipped along their top edge.
   */
  trendHeight = computed(() => {
    if (this.showChart()) return 84;
    switch (this.effectiveDensity()) {
      case 'compact':
        return 16;
      case 'list':
        return 24;
      default:
        return 26;
    }
  });

  showDeviceName = computed(() => this.fields().deviceName);

  action = input.required<DeviceActionView>();
  /** Group membership is only editable from inside a group, so the menu entry is opt-in. */
  canRemoveFromGroup = input(false);

  rename = output<DeviceActionView>();
  removeFromGroup = output<DeviceActionView>();

  constructor() {
    // One fetch per card, re-run when the action changes, when the density starts asking for a
    // trend it was not showing before, or when the shared chart range moves. A camera action is
    // skipped outright: its history is frames, not a series, and plotting base64 lengths would be
    // nonsense.
    effect(() => {
      const a = this.action();
      // Read before the early return so the effect still tracks the range and picks up a change
      // made while this tile was showing no trend.
      const range = resolveRange(this.chartRange.range());
      if (!this.showTrend() || isCameraAction(a)) {
        this.points.set([]);
        return;
      }
      this.history
        // `auto` rather than a pinned `hour`: the bucket has to follow the range, or a 6-hour
        // window returns six points and a year returns eight thousand.
        .series(a.id, { ...range, bucket: 'auto' })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (v) => this.points.set(v.points),
          // A tile whose history fails is still a working control. Empty points render the
          // chart's own "no readings" state rather than an error.
          error: () => this.points.set([]),
        });
    });

    // The last command that addressed this action. Fetched only when the field is switched on, so
    // a Compact dashboard of thirty tiles makes no extra request at all.
    effect(() => {
      const a = this.action();
      if (!this.showLastCommand() || isCameraAction(a)) {
        this.lastCommand.set(null);
        return;
      }
      this.history
        .commands({ actionId: a.id, limit: 1 })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (page) => this.lastCommand.set(page.commands[0] ?? null),
          error: () => this.lastCommand.set(null),
        });
    });
  }

  /** Compact relative stamp for the last-command line — "3m", "2h", "4d". */
  commandAge(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  iconForAction = iconForAction;
  hasTrait = hasTrait;
  activeTraitValue = activeTraitValue;
  traitIconName = traitIconName;
  controllableTraits = controllableTraits;
  isTelemetryAction = isTelemetryAction;
  isCameraAction = isCameraAction;
  colorOptions = COLOR_OPTIONS;

  private dialDragging = false;

  /** A read is in flight. Guards the menu entry so a stuck device can't be asked repeatedly. */
  refreshing = signal(false);

  @HostListener('document:pointerup')
  onDocumentPointerUp() {
    this.dialDragging = false;
  }

  /**
   * Ask the device what state it is really in (F23.6).
   *
   * Nothing is applied here: the answer arrives the way every state change does, as an
   * action_state_update the owning component folds into this action. The spinner is released on
   * the server's own timeout budget rather than on a response, since a confirming read that found
   * no change produces no state event to wait for.
   */
  refreshState(action: DeviceActionView) {
    if (this.refreshing() || !action.online) return;
    this.refreshing.set(true);
    this.userActionsService.readStateNow(action.id).subscribe({
      next: ({ timeoutMs }) => setTimeout(() => this.refreshing.set(false), timeoutMs),
      error: () => this.refreshing.set(false),
    });
  }

  changeActionState(action: DeviceActionView, actionState: unknown) {
    this.socketService.publishActionState(action.id, String(actionState));
  }

  setDefaultTrait(action: DeviceActionView, traitId: number) {
    action.defaultTraitId = traitId;
    this.userActionsService.setDefaultTrait(action.id, traitId).subscribe();
  }

  // ── Arc dial ────────────────────────────────────────────────────

  dialTrackPath(): string {
    const s = toSvgPt(START_ANGLE);
    const e = toSvgPt(START_ANGLE - TOTAL_SWEEP);
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 1 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  dialActivePath(value: unknown): string {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    if (v <= 0) return '';
    if (v >= 100) return this.dialTrackPath();
    const s = toSvgPt(START_ANGLE);
    const e = toSvgPt(START_ANGLE - (v / 100) * TOTAL_SWEEP);
    const largeArc = (v / 100) * TOTAL_SWEEP > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  dialThumbPt(value: unknown) {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    return toSvgPt(START_ANGLE - (v / 100) * TOTAL_SWEEP);
  }

  onDialPointerDown(event: PointerEvent, action: DeviceActionView) {
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    this.dialDragging = true;
    this.applyDialEvent(event, action);
  }

  onDialPointerMove(event: PointerEvent, action: DeviceActionView) {
    if (!this.dialDragging) return;
    this.applyDialEvent(event, action);
  }

  private applyDialEvent(event: PointerEvent, action: DeviceActionView) {
    const svg = event.currentTarget as SVGSVGElement;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const sp = pt.matrixTransform(svg.getScreenCTM()!.inverse());

    const dx = sp.x - CX;
    const dy = -(sp.y - CY);
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle < 0) angle += 360;

    let sweep = START_ANGLE - angle;
    if (sweep < 0) sweep += 360;
    if (sweep > TOTAL_SWEEP)
      sweep = sweep > TOTAL_SWEEP + (360 - TOTAL_SWEEP) / 2 ? 0 : TOTAL_SWEEP;

    const v = Math.round((sweep / TOTAL_SWEEP) * 100);
    action.state = v;
    this.changeActionState(action, String(v));
  }
}
