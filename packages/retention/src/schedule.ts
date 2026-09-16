// WHEN each retention job runs — parsed, validated and projected here rather than by a scheduler
// (F18.18).
//
// Phase 2 turned every retention DECISION into data. The schedule was the last one that was not:
// `RETENTION_CRON`, read once at worker startup and overridden nowhere, so changing it in prod meant
// a GitOps commit plus a promotion. Moving it into a table is only half the job — the other half is
// that **the minute tick becomes the scheduler**, comparing each job's last completion against its
// own previous scheduled occurrence. Once that is true, node-cron never sees these expressions and
// this module is the single authority on what a valid schedule is and when it fires.
//
// Pure: no database, no ambient clock, no scheduler. `api` uses it to VALIDATE a write and to show
// "next run at"; the worker uses it to ENFORCE. That is the same rule that put the clamp in this
// package — Phase 1 grew a second copy of it in the API "for display only" and the two drifted, and
// a page that states a schedule different from the one being enforced is worse than a page that
// states nothing.
//
// ── Two deliberate choices about cron semantics ──
//
// **Day-of-month and day-of-week are ANDed**, not ORed. Vixie cron famously ORs them when both are
// restricted; node-cron ANDs them (see its `time-matcher.js`), and node-cron is what has been
// running this schedule. Matching the incumbent means no expression silently changes meaning on the
// day this ships.
//
// **`a-b/n` steps from `a`**, the standard reading — `1-10/3` is 1, 4, 7, 10. node-cron instead
// keeps values divisible by `n` (3, 6, 9), which is a quirk rather than a contract; nobody can be
// relying on it here, because the only expression this platform has ever run is `0 0 3 * * *`. For
// `*/n`, the form anyone actually writes, the two readings agree.

import { badRequest } from './buckets';

/**
 * The four jobs the retention pass turned out to be.
 *
 * F18.17 split it in two — build and prune — on the observation that the halves never shared a
 * cost. The prune half was still three jobs wearing one schedule:
 *
 *   `bucket_build`   writes `sensor_rollup`, `command_rollup_daily`, `device_availability_daily`.
 *                    Cheap, incremental, idempotent, and somebody is looking at the output now.
 *   `data_sweep`     deletes raw `sensor_history`, `camera_frame_history`, `device_commands`,
 *                    `device_events` — the biggest tables in the system, irreversibly.
 *   `bucket_delete`  deletes the three rollup tables past each tier's own window. Small tables,
 *                    irreversible, and with no freshness argument whatsoever.
 *   `orphan_sweep`   deletes rollup rows whose bucket size is no longer in any tier list. **The
 *                    only one whose trigger is a person rather than a window expiring**, which is
 *                    why it wants its own cadence: dropping a tier should not have to wait for the
 *                    hour chosen for deleting a million raw readings.
 *
 * Not per data kind. That was the roadmap's own argument for a single row and it still holds — four
 * kinds × four jobs would multiply lock contention for nothing.
 */
export const RETENTION_JOBS = [
  'bucket_build',
  'data_sweep',
  'bucket_delete',
  'orphan_sweep',
] as const;

export type RetentionJob = (typeof RETENTION_JOBS)[number];

export function isRetentionJob(value: string): value is RetentionJob {
  return (RETENTION_JOBS as readonly string[]).includes(value);
}

const JOB_LABELS: Record<RetentionJob, string> = {
  bucket_build: 'summary rebuild',
  data_sweep: 'data cleanup',
  bucket_delete: 'summary cleanup',
  orphan_sweep: 'orphan cleanup',
};

/** A job named the way it is named to a person, never by its column value. */
export function describeJob(job: string): string {
  return isRetentionJob(job) ? JOB_LABELS[job] : job;
}

/** How far ahead the walkers will look before giving up. Over four years, so Feb 29 resolves. */
const MAX_LOOKAHEAD_DAYS = 1500;

/** How many occurrences the gap samplers project. Enough to see a weekly or monthly rhythm. */
const GAP_SAMPLES = 32;

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A parsed expression: every field expanded to the sorted set of values it admits. */
export interface CronFields {
  seconds: number[];
  minutes: number[];
  hours: number[];
  /** 1-31. */
  daysOfMonth: number[];
  /** 1-12. */
  months: number[];
  /** 0-6, Sunday first. */
  daysOfWeek: number[];
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
}

const FIELDS: FieldSpec[] = [
  { name: 'second', min: 0, max: 59 },
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day of week', min: 0, max: 6, names: DAY_NAMES },
];

/** Resolve a name (`sep`, `Monday`) or a number, or return null when it is neither. */
function valueOf(token: string, spec: FieldSpec): number | null {
  const lower = token.toLowerCase();
  if (spec.names) {
    // Longest match first, so `sun` inside `sunday` cannot win.
    const exact = spec.names.indexOf(lower);
    if (exact !== -1) return spec.min === 1 ? exact + 1 : exact;
    const short = spec.names.findIndex((n) => n.slice(0, 3) === lower);
    if (short !== -1) return spec.min === 1 ? short + 1 : short;
  }
  // `7` is Sunday as well as `0`, the one alias every cron implementation agrees on.
  if (spec.name === 'day of week' && lower === '7') return 0;
  if (!/^[0-9]+$/.test(lower)) return null;
  return Number(lower);
}

/** One comma-separated field expanded into the sorted, deduplicated set of values it admits. */
function parseField(raw: string, spec: FieldSpec): number[] {
  const out = new Set<number>();

  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token === '') throw badRequest(`The ${spec.name} field of the schedule has an empty entry`);

    const slash = token.indexOf('/');
    const base = slash === -1 ? token : token.slice(0, slash);
    const stepText = slash === -1 ? null : token.slice(slash + 1);

    let step = 1;
    if (stepText !== null) {
      if (!/^[0-9]+$/.test(stepText) || Number(stepText) === 0)
        throw badRequest(`"${stepText}" is not a step the ${spec.name} field can use`);
      step = Number(stepText);
    }

    let from: number;
    let to: number;
    if (base === '*') {
      from = spec.min;
      to = spec.max;
    } else {
      const dash = base.indexOf('-');
      if (dash > 0) {
        const lo = valueOf(base.slice(0, dash), spec);
        const hi = valueOf(base.slice(dash + 1), spec);
        if (lo === null || hi === null)
          throw badRequest(`"${base}" is not a range the ${spec.name} field understands`);
        if (lo > hi)
          throw badRequest(
            `The ${spec.name} range "${base}" runs backwards — ${lo} is after ${hi}`,
          );
        from = lo;
        to = hi;
      } else {
        const one = valueOf(base, spec);
        if (one === null)
          throw badRequest(`"${base}" is not a value the ${spec.name} field understands`);
        // A bare number with a step means "from here to the end of the field", as cron has it.
        from = one;
        to = stepText === null ? one : spec.max;
      }
    }

    if (from < spec.min || to > spec.max)
      throw badRequest(
        `The ${spec.name} field must be between ${spec.min} and ${spec.max}, got "${token}"`,
      );

    for (let v = from; v <= to; v += step) out.add(v);
  }

  if (out.size === 0) throw badRequest(`The ${spec.name} field of the schedule matches nothing`);
  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a 5- or 6-field cron expression.
 *
 * Five fields get a `0` second prepended, exactly as node-cron does, so an expression written for
 * the old `RETENTION_CRON` keeps meaning what it meant.
 */
export function parseCron(expr: string): CronFields {
  const parts = expr
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '');
  if (parts.length !== 5 && parts.length !== 6)
    throw badRequest(
      `A schedule needs 5 or 6 fields (minute hour day month weekday, optionally seconds first), got ${parts.length}`,
    );
  const six = parts.length === 6 ? parts : ['0', ...parts];

  const [seconds, minutes, hours, daysOfMonth, months, daysOfWeek] = six.map((raw, i) =>
    parseField(raw, FIELDS[i]!),
  ) as [number[], number[], number[], number[], number[], number[]];

  return { seconds, minutes, hours, daysOfMonth, months, daysOfWeek };
}

// ── Timezone arithmetic ──────────────────────────────────────────────────────
//
// A "quiet hour" is a local wall-clock concept, so the whole point of storing a zone is that 03:00
// means 03:00 where the owner lives. `Intl` is the only timezone database Node ships, and it goes
// one way — instant to wall clock. Going back is the inversion below.

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const hit = formatterCache.get(timeZone);
  if (hit) return hit;
  const made = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone,
  });
  formatterCache.set(timeZone, made);
  return made;
}

/** Is this a zone `Intl` knows? The only validation available, and the only one that matters. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading of an instant in a zone. */
function wallOf(instant: number, timeZone: string): Wall {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function wallAsUtc(w: Wall): number {
  // `Date.UTC` maps years 0-99 onto 1900-1999; no zone we format will produce one, but being
  // explicit costs nothing and a silent 1,900-year error is not a thing to leave to chance.
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, 0);
  return d.getTime();
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  return wallAsUtc(wallOf(instant, timeZone)) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which a zone's clock reads exactly this wall time — or null when it never does.
 *
 * Two candidates are tried because a wall time can sit on either side of a transition, and the two
 * DST cases are decided here rather than left to whichever one the arithmetic happened to find:
 *
 *   SPRING FORWARD  02:30 does not exist on the day the clocks jump 02:00 → 03:00. Neither
 *                   candidate round-trips, so this returns null and the walker skips that day.
 *                   Nothing downstream then runs a spurious catch-up: `prevOccurrence` simply
 *                   returns YESTERDAY's 02:30, which has already run.
 *   FALL BACK       02:30 happens twice. Both candidates round-trip, and we take the EARLIER, so
 *                   the job runs once. The second is suppressed by `lastRunAt >= prevOccurrence`.
 */
function instantOf(w: Wall, timeZone: string): number | null {
  const target = wallAsUtc(w);
  const roundTrips = (candidate: number) => {
    const back = wallOf(candidate, timeZone);
    return (
      back.year === w.year &&
      back.month === w.month &&
      back.day === w.day &&
      back.hour === w.hour &&
      back.minute === w.minute &&
      back.second === w.second
    );
  };

  // Probe the offset on BOTH sides of the target, a day out each way, not just at the target
  // itself. On a fall-back day the naive probes converge on the post-transition offset and the
  // earlier of the two real instants is never generated — the job would then run at the second
  // 01:30 rather than the first. Once each way is enough: no zone transitions twice in a day.
  const DAY = 86_400_000;
  const offsets = new Set([
    offsetAt(target - DAY, timeZone),
    offsetAt(target, timeZone),
    offsetAt(target + DAY, timeZone),
  ]);

  const valid = [...offsets].map((o) => target - o).filter(roundTrips);
  return valid.length === 0 ? null : Math.min(...valid);
}

// ── Occurrences ──────────────────────────────────────────────────────────────

function dayMatches(fields: CronFields, w: Wall): boolean {
  if (!fields.months.includes(w.month)) return false;
  if (!fields.daysOfMonth.includes(w.day)) return false;
  // `Date.UTC` on the wall-clock date gives the weekday of that CALENDAR day, which is what a cron
  // expression means — not the weekday of the instant in some other zone.
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  return fields.daysOfWeek.includes(weekday);
}

/** Step a calendar date by whole days, staying in the zone's own calendar. */
function shiftDay(w: Wall, days: number): Wall {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
  d.setUTCDate(d.getUTCDate() + days);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/**
 * The first firing strictly after `after`.
 *
 * Walks the ZONE's calendar day by day, then the admitted (hour, minute, second) tuples within a
 * matching day. Lower bounds are carried into the first day's tuple loop, so the usual cost is one
 * scan of each field rather than their product.
 *
 * Returns null for an expression nothing satisfies inside the lookahead — `31 2 *` is the honest
 * example, and returning null rather than looping forever is what lets a schedule like that be
 * refused with a reason instead of hanging a request.
 */
export function nextOccurrence(fields: CronFields, timeZone: string, after: Date): Date | null {
  const afterMs = after.getTime();
  let day = wallOf(afterMs, timeZone);
  const start = { hour: day.hour, minute: day.minute, second: day.second };

  for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
    if (dayMatches(fields, day)) {
      const firstDay = i === 0;
      for (const hour of fields.hours) {
        if (firstDay && hour < start.hour) continue;
        for (const minute of fields.minutes) {
          if (firstDay && hour === start.hour && minute < start.minute) continue;
          for (const second of fields.seconds) {
            if (firstDay && hour === start.hour && minute === start.minute && second < start.second)
              continue;
            const at = instantOf({ ...day, hour, minute, second }, timeZone);
            if (at !== null && at > afterMs) return new Date(at);
          }
        }
      }
    }
    day = shiftDay(day, 1);
  }
  return null;
}

/**
 * The most recent firing at or before `before`.
 *
 * **This is the one the tick runs.** "Has this job run since it was last due?" is the whole
 * scheduler once the answer lives in `retention_runs` rather than in a scheduler's memory — it needs
 * no cursor, no record of missed occurrences, and it survives a restart.
 */
export function prevOccurrence(fields: CronFields, timeZone: string, before: Date): Date | null {
  const beforeMs = before.getTime();
  let day = wallOf(beforeMs, timeZone);
  const end = { hour: day.hour, minute: day.minute, second: day.second };

  const desc = (values: number[]) => [...values].reverse();

  for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
    if (dayMatches(fields, day)) {
      const firstDay = i === 0;
      for (const hour of desc(fields.hours)) {
        if (firstDay && hour > end.hour) continue;
        for (const minute of desc(fields.minutes)) {
          if (firstDay && hour === end.hour && minute > end.minute) continue;
          for (const second of desc(fields.seconds)) {
            if (firstDay && hour === end.hour && minute === end.minute && second > end.second)
              continue;
            const at = instantOf({ ...day, hour, minute, second }, timeZone);
            if (at !== null && at <= beforeMs) return new Date(at);
          }
        }
      }
    }
    day = shiftDay(day, -1);
  }
  return null;
}

/**
 * The gaps between the next few firings, in seconds.
 *
 * Sampled, never averaged. `0 0,1 3 * * *` fires twice a day: its average gap is twelve hours and
 * its real gap is one minute, so an average would wave through exactly the schedule the floor exists
 * to refuse.
 *
 * An expression that cannot produce two firings yields `{ min: Infinity, max: Infinity }` — unknown
 * reads as "unboundedly rare", which is the safe direction for both callers: it passes the
 * frequency floor and fails the freshness check in `assertBuildKeepsUpWithRaw`.
 */
export function occurrenceGaps(
  fields: CronFields,
  timeZone: string,
  from: Date,
  samples: number = GAP_SAMPLES,
): { min: number; max: number } {
  const times: number[] = [];
  let cursor = from;
  for (let i = 0; i < samples; i++) {
    const next = nextOccurrence(fields, timeZone, cursor);
    if (next === null) break;
    times.push(next.getTime());
    cursor = next;
  }
  if (times.length < 2) return { min: Infinity, max: Infinity };

  let min = Infinity;
  let max = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i]! - times[i - 1]!) / 1000;
    if (gap < min) min = gap;
    if (gap > max) max = gap;
  }
  return { min, max };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Parse, check the zone, and refuse a schedule that fires more often than `floorSeconds`.
 *
 * The floor is per-caller because the jobs are not alike: building buckets is cheap, incremental and
 * idempotent, while the three destructive jobs issue bounded DELETEs against the biggest tables in
 * the system. F18.17 stopped those two halves sharing a cadence; they should not share a floor
 * either.
 */
export function assertScheduleAdmissible(
  expr: string,
  timeZone: string,
  floorSeconds: number,
  now: Date = new Date(),
): CronFields {
  const fields = parseCron(expr);
  if (!isKnownTimeZone(timeZone))
    throw badRequest(`"${timeZone}" is not a time zone this system knows`);

  const { min } = occurrenceGaps(fields, timeZone, now);
  if (min === Infinity) {
    // Parsed, but nothing satisfies it — `0 0 3 31 2 *` is the honest example.
    if (nextOccurrence(fields, timeZone, now) === null)
      throw badRequest(`"${expr}" describes a date that never happens`);
    return fields;
  }
  if (min < floorSeconds)
    throw badRequest(
      `That schedule would run every ${describeGap(min)}, and the limit is once every ` +
        `${describeGap(floorSeconds)} — ${
          floorSeconds >= 3600
            ? 'this job deletes rows from the largest tables in the system'
            : 'more often than that is permanent background load'
        }`,
    );
  return fields;
}

/**
 * Refuse a bucket-build schedule that lets raw rows expire before they have been summarised.
 *
 * **The one invariant splitting the pass can break.** A bucket is built by reading the rows it
 * summarises, so raw deleted before a build pass has seen it produces permanently empty buckets for
 * exactly the periods someone asked to COMPRESS rather than lose. The single pass guaranteed the
 * order for free; four schedules do not.
 *
 * Note what is NOT part of this: the data-sweep schedule. A sweep running every minute still only
 * deletes rows past `raw.keepDays`, so how often it runs cannot cause the loss. Data is lost iff a
 * row ages past its raw window before a build reads it, which is one comparison:
 *
 *     max gap between build passes  <  the shortest raw window configured anywhere
 *
 * Checked from both sides, because either write can make the pair unsafe — here when the build
 * schedule moves, and through `rawFloorDays` when a raw window does.
 */
export function assertBuildKeepsUpWithRaw(
  gapSeconds: number,
  minRawKeepDays: number,
  marginFactor = 2,
): void {
  // 0 is KEEP FOREVER on a window, so nothing can expire before it is summarised.
  if (minRawKeepDays === 0) return;
  const rawSeconds = minRawKeepDays * 86_400;
  if (gapSeconds * marginFactor <= rawSeconds) return;
  throw badRequest(
    `That schedule leaves up to ${describeGap(gapSeconds)} between rebuilds, but the shortest raw ` +
      `window configured is ${minRawKeepDays} day${minRawKeepDays === 1 ? '' : 's'} — readings ` +
      `would be deleted before they were ever summarised. Build at least every ` +
      `${describeGap(rawSeconds / marginFactor)}, or lengthen the raw window.`,
  );
}

/** How many days a raw window must cover for a build running this far apart to keep up. */
export function rawDaysNeededForGap(gapSeconds: number, marginFactor = 2): number {
  return Math.ceil((gapSeconds * marginFactor) / 86_400);
}

// ── Describing ───────────────────────────────────────────────────────────────

/** A duration as a person would say it. Used only in messages, never parsed back. */
export function describeGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'never';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(Math.round(seconds), 'second');
  if (seconds < 3_600) return unit(Math.round(seconds / 60), 'minute');
  if (seconds < 86_400) return unit(Math.round(seconds / 3_600), 'hour');
  if (seconds < 604_800) return unit(Math.round(seconds / 86_400), 'day');
  return unit(Math.round(seconds / 604_800), 'week');
}

function isFull(values: number[], min: number, max: number): boolean {
  return values.length === max - min + 1;
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Is this a plain arithmetic series, and what is its step? */
function stepOf(values: number[]): number | null {
  if (values.length < 2) return null;
  const step = values[1]! - values[0]!;
  for (let i = 2; i < values.length; i++) if (values[i]! - values[i - 1]! !== step) return null;
  return step;
}

/**
 * A schedule in plain language — "Every day at 03:00 (Asia/Jerusalem)".
 *
 * Falls back to the raw expression for anything it does not recognise. A describer that guesses is
 * worse than one that declines: the sentence is what an admin checks their intent against, so being
 * wrong here is worse than being silent.
 */
export function describeSchedule(expr: string, timeZone: string): string {
  let fields: CronFields;
  try {
    fields = parseCron(expr);
  } catch {
    return expr;
  }

  const zone = ` (${timeZone})`;
  const everyDate = isFull(fields.daysOfMonth, 1, 31) && isFull(fields.months, 1, 12);
  const everyWeekday = isFull(fields.daysOfWeek, 0, 6);
  const oneSecond = fields.seconds.length === 1 && fields.seconds[0] === 0;

  // Sub-hourly: "every 15 minutes".
  if (oneSecond && isFull(fields.hours, 0, 23) && everyDate && everyWeekday) {
    if (fields.minutes.length === 1)
      return `Every hour at :${String(fields.minutes[0]).padStart(2, '0')}${zone}`;
    const step = stepOf(fields.minutes);
    if (step !== null && fields.minutes[0] === 0 && fields.minutes.length === 60 / step)
      return `Every ${describeGap(step * 60)}${zone}`;
  }

  if (oneSecond && fields.minutes.length === 1) {
    const minute = fields.minutes[0]!;

    // "Every 6 hours at :00".
    if (everyDate && everyWeekday && fields.hours.length > 1) {
      const step = stepOf(fields.hours);
      if (step !== null && fields.hours[0] === 0 && fields.hours.length === 24 / step)
        return `Every ${describeGap(step * 3_600)} at :${String(minute).padStart(2, '0')}${zone}`;
    }

    if (fields.hours.length === 1) {
      const at = hhmm(fields.hours[0]!, minute);
      if (everyDate && everyWeekday) return `Every day at ${at}${zone}`;
      // "The 1st of every month" — a plausible cadence for deleting summaries, which are small.
      if (everyWeekday && isFull(fields.months, 1, 12) && fields.daysOfMonth.length === 1) {
        const d = fields.daysOfMonth[0]!;
        const suffix =
          d % 10 === 1 && d !== 11
            ? 'st'
            : d % 10 === 2 && d !== 12
              ? 'nd'
              : d % 10 === 3 && d !== 13
                ? 'rd'
                : 'th';
        return `The ${d}${suffix} of every month at ${at}${zone}`;
      }
      if (everyDate && fields.daysOfWeek.length >= 1 && fields.daysOfWeek.length < 7) {
        const days = fields.daysOfWeek
          .map((d) => DAY_NAMES[d]!)
          .map((n) => n[0]!.toUpperCase() + n.slice(1));
        const list =
          days.length === 1
            ? days[0]!
            : `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]!}`;
        return `Every ${list} at ${at}${zone}`;
      }
    }
  }

  return `${expr}${zone}`;
}

// ── The scheduler's one question ─────────────────────────────────────────────

/**
 * Has this job missed its slot?
 *
 * Replaces the fixed 25-hour fuse F18.17 shipped, which was correct only while the schedule was a
 * constant. Once an admin can choose it, a constant fuse silently overrides them: a weekly schedule
 * would be upgraded to daily, and switching a job off would hold for 25 hours and then run anyway.
 * Comparing against the job's OWN previous occurrence is exact for any expression, and makes
 * `enabled: false` mean what it says.
 *
 * A job that has never run is due as soon as it has an occurrence behind it — not immediately on
 * first boot, or installing the platform would trigger a full sweep before anyone had configured
 * anything.
 */
export function isJobDue(
  lastFinishedAt: Date | null,
  previousOccurrence: Date | null,
  now: Date,
  graceMs = 0,
): boolean {
  if (previousOccurrence === null) return false;
  if (now.getTime() - previousOccurrence.getTime() < graceMs) return false;
  if (lastFinishedAt === null) return true;
  return lastFinishedAt.getTime() < previousOccurrence.getTime();
}
