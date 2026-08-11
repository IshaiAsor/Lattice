import { DeviceTrack, PhaseTrackItem } from 'src/app/services/blueprints.service';

// Drawing a whole lifecycle as one bar (F11.4).
//
// A track is the phases of one owner — a setup, or a single bound device — sized by how long each
// phase lasts and filled by how much of it has been spent. Both the setups list and the dashboard
// tile draw it, so the arithmetic lives here rather than twice: a phase that reads "half done" on
// the dashboard must read half done on the list, and the only way to guarantee that is one
// function.
//
// Every function takes the caller's `tick` — seconds elapsed since the response was rendered — and
// applies it to the current phase only, and only while the owner is running. That is what lets a
// page count down without re-fetching, and it is why a parked track never moves.

/** A phase with no limit still has to occupy the rail. It takes the average of the bounded ones. */
export function phaseWeight(phase: PhaseTrackItem, phases: PhaseTrackItem[]): number {
  if (phase.duration_seconds) return phase.duration_seconds;
  const bounded = phases.filter((p) => p.duration_seconds).map((p) => p.duration_seconds!);
  if (bounded.length === 0) return 1;
  return bounded.reduce((a, b) => a + b, 0) / bounded.length;
}

/** Time spent in one phase, ticked forward locally rather than re-fetched. */
export function phaseElapsed(phase: PhaseTrackItem, tick: number, running: boolean): number {
  return phase.elapsed_seconds + (phase.is_current && running ? tick : 0);
}

/**
 * How full one segment is, 0–100.
 *
 * A phase before the current one reads full whether or not its bank says so: the owner has left
 * it, and a half-filled segment behind a live one would read as unfinished work rather than as
 * history. A phase with no limit reads full once entered — there is no fraction of "until you say
 * so" to show.
 */
export function phaseFillPercent(
  phase: PhaseTrackItem,
  phases: PhaseTrackItem[],
  tick: number,
  running: boolean,
): number {
  const current = currentIndex(phases);
  const index = phases.indexOf(phase);
  if (current === -1) return 0; // never started: the shape of what is ahead, nothing filled
  if (index < current) return 100;
  if (index > current) return 0;
  if (!phase.duration_seconds) return 100;
  return Math.min(100, (phaseElapsed(phase, tick, running) / phase.duration_seconds) * 100);
}

export function currentIndex(phases: PhaseTrackItem[]): number {
  return phases.findIndex((p) => p.is_current);
}

export function currentPhase(phases: PhaseTrackItem[]): PhaseTrackItem | null {
  return phases.find((p) => p.is_current) ?? null;
}

/**
 * How far through the whole lifecycle, 0–100 — weighted by duration, so a track that is one short
 * phase from the end reads nearly done rather than "3 of 4".
 */
export function overallPercent(phases: PhaseTrackItem[], tick: number, running: boolean): number {
  if (phases.length === 0) return 0;
  const total = phases.reduce((sum, p) => sum + phaseWeight(p, phases), 0);
  if (total <= 0) return 0;
  const done = phases.reduce(
    (sum, p) => sum + (phaseFillPercent(p, phases, tick, running) / 100) * phaseWeight(p, phases),
    0,
  );
  return Math.min(100, (done / total) * 100);
}

/**
 * "2/4" — which phase, of how many. Shown beside the percentage rather than instead of it: a ring
 * at 62% does not say what the setup is *doing*, and a phase number does not say how far in it is.
 */
export function positionLabel(phases: PhaseTrackItem[]): string {
  if (phases.length === 0) return '';
  const index = currentIndex(phases);
  return `${index + 1}/${phases.length}`;
}

/**
 * Of several devices on their own schedules, the one that will need you first.
 *
 * A running device always beats a parked one — one about to advance matters more than one that has
 * been sitting for a week — and among those, the shortest time left wins. Deliberately not "the
 * furthest along": a card that summarises several devices with a single number should point at the
 * next thing to happen, not the one that has already happened most. Both the setups list and the
 * dashboard tile use this, so the two surfaces cannot describe the same setup differently.
 */
export function leadTrack(tracks: DeviceTrack[], tick: number): DeviceTrack | null {
  if (tracks.length === 0) return null;
  const live = tracks.filter((t) => t.effective_state === 'running');
  const pool = live.length > 0 ? live : tracks;
  return pool.reduce((soonest, t) =>
    remainingOf(t, tick) < remainingOf(soonest, tick) ? t : soonest,
  );
}

/** Seconds before this device's current phase runs out; infinite when it has no limit. */
export function remainingOf(track: DeviceTrack, tick: number): number {
  if (track.duration_seconds === null) return Number.POSITIVE_INFINITY;
  const elapsed = track.elapsed_seconds + (track.effective_state === 'running' ? tick : 0);
  return Math.max(0, track.duration_seconds - elapsed);
}

/**
 * A phase that has run past its length and is waiting on the user. Worth surfacing on a dashboard:
 * it is the one state where nothing will happen until someone acts.
 */
export function dueToAdvance(phases: PhaseTrackItem[], tick: number, running: boolean): boolean {
  const phase = currentPhase(phases);
  if (!phase || !running || !phase.duration_seconds) return false;
  return phaseElapsed(phase, tick, running) >= phase.duration_seconds;
}
