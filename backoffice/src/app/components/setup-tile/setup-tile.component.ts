import { Component, input, output } from '@angular/core';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceTrack, InstanceSummary, PhaseTrackItem } from 'src/app/services/blueprints.service';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { ActionCardComponent } from '../action-card/action-card.component';
import {
  controlStateLabel,
  iconForAction,
  isActiveState,
  isCameraAction,
  isTelemetryAction,
  sensorReadingOf,
  SensorReading,
} from 'src/app/utils/device-type.utils';
import {
  currentPhase,
  dueToAdvance,
  leadTrack,
  overallPercent,
  phaseFillPercent,
  phaseWeight,
  positionLabel,
} from 'src/app/utils/phase-track.util';
import { currentPhaseTimerLabel, formatDuration } from '../blueprint-instance/phase-timer.util';

// The dashboard's view of a setup (F11.4) — the setups list's fleet panel with the controls taken
// out and the glance kept in.
//
// The dashboard is a different job from the setups page: nobody operates a lifecycle here, they
// check whether anything needs them before moving on. So the tile shows the ring, the phase, and
// one rail per device, and a tap opens the card's own devices rather than navigating anywhere —
// unlike a scene tile, which is a fire-and-forget action. Everything that leaves the page or moves
// a lifecycle (edit, pause / continue / reset) lives in the kebab, where it cannot be hit by
// accident while reaching for a reading.
//
// The live surface: the devices a setup owns used to appear twice over — once as rails here, and
// again as loose action cards further down the page, mixed in with every other device in the house.
// So the readings that say whether the setup is doing its job were the one thing the setup's own
// card did not show. The tile now carries them: a *strip* of the readings and controls while
// collapsed, and every one of them, as ordinary action cards, when expanded in place. The dashboard
// no longer lists a setup's actions separately, so each appears exactly once.
//
// Presentational only: the dashboard owns the calls, matching SceneTileComponent.

/** One rail in the tile body — a device's lifecycle, or the setup's own. */
interface TileTrack {
  key: string;
  label: string;
  state: string;
  phases: PhaseTrackItem[];
}

/** One reading in the collapsed strip. */
interface ReadingPill {
  action: DeviceActionView;
  label: string;
  reading: SensorReading | null;
}

/** Rails past this get a "+n" line. A tile must not scroll. */
const MAX_RAILS = 3;
/** The collapsed strip's budget. Past these the tile counts rather than lists (see `liveSummary`). */
const MAX_PILLS = 4;
// Two, not three: a chip carrying its binding's label ("Lettuce by the window · Socket 1") takes a
// whole row, and a third row is exactly what the tile does not have between the rails and the
// footer. What is not shown is counted in the strip's header, which costs no row at all.
const MAX_CHIPS = 2;

@Component({
  selector: 'app-setup-tile',
  standalone: true,
  imports: [SHARED_MATERIAL, ActionCardComponent],
  templateUrl: './setup-tile.component.html',
  styleUrl: './setup-tile.component.css',
})
export class SetupTileComponent {
  setup = input.required<InstanceSummary>();
  /**
   * The actions of every device this setup binds, in the dashboard's own order. The dashboard
   * mutates these objects from its socket subscriptions, so the strip and the embedded cards both
   * stay live without this component subscribing to anything.
   */
  actions = input<DeviceActionView[]>([]);
  /** Owned by the dashboard so only one setup is open at a time and the row can re-flow for it. */
  expanded = input(false);
  /** Seconds since the dashboard's last load, so the timers count down without re-fetching. */
  tick = input<number>(0);
  // Not `open`/`pause`/`reset`: those are native DOM event names, and an output that shadows one
  // fires twice as often as it looks like it should.
  openSetup = output<void>();
  pauseSetup = output<void>();
  resumeSetup = output<void>();
  resetSetup = output<void>();
  toggleExpand = output<void>();
  renameAction = output<DeviceActionView>();

  iconForAction = iconForAction;
  controlStateLabel = controlStateLabel;
  isActiveState = isActiveState;

  isRunning(): boolean {
    return this.setup().lifecycle_state === 'running';
  }

  isStopped(): boolean {
    return this.setup().lifecycle_state === 'stopped';
  }

  /** Reset discards banked time, so something has to have banked some. */
  canReset(): boolean {
    const s = this.setup();
    if (s.lifecycle_state === 'not_started') return false;
    return s.has_phases || s.device_tracks.length > 0;
  }

  // ── Live surface ─────────────────────────────────────────────────────

  /**
   * Readings first, and among them the ones that have gone quiet — an offline sensor is the only
   * thing here a person can act on, and it is exactly the one a "top 4" would otherwise drop for
   * having no fresh value. Nothing is ranked by how extreme its value is: an action carries no
   * range to be outside of, so the tile would be inventing the threshold it claimed to check.
   */
  readings(): ReadingPill[] {
    return this.actions()
      .filter(a => isTelemetryAction(a))
      .sort((a, b) => Number(a.online) - Number(b.online) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(a => ({ action: a, label: this.labelFor(a), reading: sensorReadingOf(a) }));
  }

  /**
   * A setup binds several devices of the same type as a matter of course, and they arrive from the
   * catalog with the same action names — three bindings, three actions all called "Socket 1". The
   * name alone then identifies nothing, so the device joins it, but only where it has to: prefixing
   * every chip would cost the width that makes the strip readable in the common case.
   */
  labelFor(action: DeviceActionView): string {
    const ambiguous = this.actions().filter(a => a.name === action.name).length > 1;
    return ambiguous ? `${this.deviceLabel(action)} · ${action.name}` : action.name;
  }

  /**
   * What to call the device an action sits on. The binding's label first — it is the name the user
   * gave this device *in this setup* ("Lettuce by the window"), and it is the only one that tells
   * two bindings apart when both devices carry the catalog's type name.
   */
  private deviceLabel(action: DeviceActionView): string {
    const track = this.setup().device_tracks.find(t => t.user_device_id === action.deviceId);
    return track?.label ?? action.deviceName;
  }

  /** Everything that is not a read-out: the switches, dials and camera feeds. */
  controls(): DeviceActionView[] {
    return this.actions()
      .filter(a => !isTelemetryAction(a))
      .sort((a, b) => Number(a.online) - Number(b.online) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  visiblePills(): ReadingPill[] {
    return this.readings().slice(0, MAX_PILLS);
  }

  visibleChips(): DeviceActionView[] {
    return this.controls().slice(0, MAX_CHIPS);
  }

  /**
   * "1 reading · 6 controls" — what the setup holds, not what the strip left out. A "+n hidden"
   * count would have to know how many chips the current width actually fit, and the narrow tile
   * drops the chip row wholesale; totals are true at every width and answer the same question.
   */
  liveSummary(): string {
    const readings = this.readings().length;
    const controls = this.controls().length;
    const parts: string[] = [];
    if (readings > 0) parts.push(`${readings} reading${readings === 1 ? '' : 's'}`);
    if (controls > 0) parts.push(`${controls} control${controls === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  hasLive(): boolean {
    return this.actions().length > 0;
  }

  /**
   * The card body toggles its own panel. A setup with nothing bound has nothing to reveal, so it
   * stays inert rather than opening onto an empty panel — its kebab still reaches the setup page.
   */
  onCardActivate() {
    if (this.hasLive()) this.toggleExpand.emit();
  }

  cardActionLabel(): string {
    const name = this.setup().name;
    if (!this.hasLive()) return name;
    return this.expanded()
      ? `Hide the readings and controls of ${name}`
      : `Show the readings and controls of ${name}`;
  }

  isCameraAction = isCameraAction;

  /**
   * "4s ago" for the freshest reading this tab has actually seen. `receivedAt` is set by the
   * dashboard when a socket update lands, so it is empty until one does — and an empty label is
   * the truth there, where "0s ago" would be a claim about a value that arrived with the page.
   */
  freshest(): string {
    const stamps = this.actions()
      .map(a => a.receivedAt)
      .filter((t): t is number => typeof t === 'number');
    if (stamps.length === 0) return '';
    const seconds = Math.max(0, Math.round((Date.now() - Math.max(...stamps)) / 1000));
    return seconds < 60 ? `updated ${seconds}s ago` : `updated ${formatDuration(seconds)} ago`;
  }

  /** Offline devices are the strip's one honest alarm; the count rides in the footer. */
  offlineCount(): number {
    return this.actions().filter(a => !a.online).length;
  }

  // ── Tracks ───────────────────────────────────────────────────────────

  tracks(): TileTrack[] {
    const s = this.setup();
    if (s.device_tracks.length > 0) {
      return s.device_tracks.slice(0, MAX_RAILS).map((d) => ({
        key: `binding-${d.binding_id}`,
        label: d.label,
        state: d.effective_state,
        phases: d.phases,
      }));
    }
    if (s.phases.length === 0) return [];
    return [
      {
        key: `setup-${s.id}`,
        label: s.name,
        state: s.lifecycle_state,
        phases: s.phases,
      },
    ];
  }

  /** True for a setup whose devices each run their own schedule — the rails then need labels. */
  perDevice(): boolean {
    return this.setup().device_tracks.length > 0;
  }

  hiddenCount(): number {
    return Math.max(0, this.setup().device_tracks.length - MAX_RAILS);
  }

  /**
   * The device that will need you first — a dashboard should surface the soonest change rather
   * than an average, which is a position no device is actually in. Shared with the setups list so
   * the two surfaces cannot point at different devices for the same setup.
   */
  private lead(): DeviceTrack | null {
    return leadTrack(this.setup().device_tracks, this.tick());
  }

  /** The track the ring describes: the setup's own, else the device nearest a change. */
  private headTrack(): PhaseTrackItem[] {
    const s = this.setup();
    if (s.phases.length > 0) return s.phases;
    return this.lead()?.phases ?? [];
  }

  hasTrack(): boolean {
    return this.headTrack().length > 0;
  }

  percent(): number {
    return overallPercent(this.headTrack(), this.tick(), this.isRunning());
  }

  position(): string {
    return positionLabel(this.headTrack());
  }

  /** "Steady" — what the setup is doing, which is what a person recognises before any number. */
  phaseName(): string {
    const s = this.setup();
    if (s.lifecycle_state === 'not_started') return 'Not started';
    const phase = currentPhase(this.headTrack());
    if (phase) return phase.name;
    // A setup with no lifecycle anywhere is simply on. Naming the blueprint here would put a key
    // where a phase belongs and read as a phase called "garden_pots".
    if (!s.has_phases && s.device_tracks.length === 0) return 'No schedule';
    return 'No phase yet';
  }

  /** "1d 4h · Zone 1" — the clock, and whose it is. */
  timer(): string {
    const s = this.setup();
    if (!s.has_phases && s.device_tracks.length === 0) return `from ${s.blueprint_key}`;
    if (s.lifecycle_state === 'not_started') {
      const count = this.headTrack().length;
      return count > 0 ? `${count} phases ahead` : 'not started';
    }
    const device = this.lead();
    if (!device) {
      if (!s.current_phase) return '';
      return currentPhaseTimerLabel(
        s.elapsed_seconds + (this.isRunning() ? this.tick() : 0),
        s.duration_seconds,
        this.isRunning(),
      );
    }
    const running = device.effective_state === 'running';
    const elapsed = device.elapsed_seconds + (running ? this.tick() : 0);
    // Shorter than the list's phrasing on purpose: naming the device is worth more than the word
    // "left", and both together overrun the tile.
    const clock = running
      ? device.duration_seconds === null
        ? formatDuration(elapsed)
        : elapsed >= device.duration_seconds
          ? 'due to advance'
          : formatDuration(device.duration_seconds - elapsed)
      : `${formatDuration(elapsed)} in`;
    return `${clock} · ${device.label}`;
  }

  // ── Rails ────────────────────────────────────────────────────────────

  weightOf(track: TileTrack, phase: PhaseTrackItem): number {
    return phaseWeight(phase, track.phases);
  }

  fillOf(track: TileTrack, phase: PhaseTrackItem): number {
    const running = track.state === 'running';
    return phaseFillPercent(phase, track.phases, running ? this.tick() : 0, running);
  }

  railLabel(track: TileTrack): string {
    const index = track.phases.findIndex((p) => p.is_current);
    if (index === -1) return `${track.label}: not started, ${track.phases.length} phases`;
    return `${track.label}: phase ${index + 1} of ${track.phases.length}, ${track.phases[index]!.name}`;
  }

  // ── Footer ───────────────────────────────────────────────────────────

  /**
   * A phase that has run out and is waiting on a person is the one thing on this page that will
   * not resolve itself, so the tile says so and borders itself in the warning colour.
   */
  dueCount(): number {
    const s = this.setup();
    if (s.device_tracks.length > 0) {
      return s.device_tracks.filter((d) =>
        dueToAdvance(d.phases, this.tick(), d.effective_state === 'running'),
      ).length;
    }
    return dueToAdvance(s.phases, this.tick(), this.isRunning()) ? 1 : 0;
  }

  footer(): string {
    const s = this.setup();
    if (s.device_tracks.length > 0) {
      const suffix = this.isRunning() ? '' : ' · paused';
      return `${s.devices.total} device${s.devices.total === 1 ? '' : 's'} · ${s.devices.running} running${suffix}`;
    }
    if (this.isRunning()) return 'Running';
    return this.isStopped() ? 'Paused' : 'Not started';
  }
}
