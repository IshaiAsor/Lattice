import { isParamRef } from './resolve';

// The one schedule shape in the platform, and the one evaluator for it.
//
// Four tables carry a schedule — `user_rule_conditions`, `pipeline_triggers` and the two
// blueprint template tables behind them — and before this each surface had its own idea of what a
// schedule was: a rule matched one minute of the day, a pipeline stored a 6-field cron that was
// never read by anything. One spec, one validator, one matcher and one describer live here so a
// schedule means the same thing wherever it is written, and so a fix lands once.
//
// Pure — no I/O, no Prisma — so api (validation), automation-worker (evaluation) and the tests can
// all use it. The backoffice keeps its own describer because it is a separate npm project and
// cannot import from here; that copy is cosmetic only, never the decision.

/**
 * A schedule, as both a rule condition and a pipeline trigger express it.
 *
 * Two shapes in one, distinguished by whether the window fields are set:
 *
 *   time only                  fires at exactly that minute, once a day
 *   time + until + every       fires at `time`, `time + every`, … through `until`
 *
 * The second is the "loop" shape — "06:00 to 17:30, every 10 minutes" — which previously had no
 * expression at all: a rule matched one minute of the day, so a working day of ten-minute runs
 * meant sixty-nine rules. How LONG the device then stays on is not part of this; that is the
 * action's `duration_seconds`, held by the device itself. This says WHEN, that says HOW LONG.
 */
export interface ScheduleSpec {
  /** HH:MM. The single firing time, or the start of the window. */
  time: string | null;
  /** HH:MM, inclusive. Null = no window, i.e. the single-time shape. */
  until?: string | null;
  /** Minutes between firings inside the window. Null = no window. */
  everyMinutes?: number | null;
  /** JS getDay() numbering, 0 = Sunday. Empty = every day. */
  days: number[];
}

/** HH:MM → minutes since midnight, or null if it is not a time. */
export function minutesOfDay(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// ── Timezone ──────────────────────────────────────────────────────────────────

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Building an Intl.DateTimeFormat costs real time and the matcher runs over every rule every ten
// seconds, so keep one per zone. Bounded by the number of distinct user timezones, not by calls.
const formatters = new Map<string, Intl.DateTimeFormat>();

/** True if the runtime recognises this IANA zone name. Used to reject a bad value at the API. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the clock reads *where the schedule's owner lives*.
 *
 * Without this, a schedule is evaluated in the timezone of whichever process happens to run the
 * matcher — which in a container is UTC. A user who wrote "06:00" got 06:00 UTC, three hours late
 * in Israel, and the single-time shape made it easy to miss. A window makes it obvious: "from 06:00
 * to 17:30" is a sentence about daylight.
 *
 * `timeZone` null/empty means "the server's own zone", which is the pre-timezone behaviour and the
 * fallback for a stored zone this runtime does not know (an ICU update can retire a name; a
 * schedule silently not firing would be worse than one firing in the server's zone).
 */
export function zonedClock(now: Date, timeZone?: string | null): { minutes: number; day: number } {
  if (!timeZone) return { minutes: now.getHours() * 60 + now.getMinutes(), day: now.getDay() };

  let fmt = formatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      });
    } catch {
      return { minutes: now.getHours() * 60 + now.getMinutes(), day: now.getDay() };
    }
    formatters.set(timeZone, fmt);
  }

  let hour = 0;
  let minute = 0;
  let day = 0;
  for (const part of fmt.formatToParts(now)) {
    // en-US with hour12:false renders midnight as "24" in some ICU versions — normalise it.
    if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'weekday') day = DAY_INDEX[part.value] ?? 0;
  }
  return { minutes: hour * 60 + minute, day };
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Does this schedule fire in the minute `now` falls in?
 *
 * Called once a minute per schedule, so "fires now" means "this is its minute" — the caller's
 * cooldown, not this function, is what stops a longer tick from firing twice.
 */
export function matchesSchedule(
  spec: ScheduleSpec,
  now: Date = new Date(),
  timeZone?: string | null,
): boolean {
  const start = minutesOfDay(spec.time);
  if (start === null) return false;

  const clock = zonedClock(now, timeZone);
  if (spec.days?.length && !spec.days.includes(clock.day)) return false;

  const end = minutesOfDay(spec.until);
  const every = spec.everyMinutes ?? 0;

  // No window, or a window that says nothing (zero interval): the original exact-minute match.
  // Kept as the default so every schedule written before windows existed behaves identically.
  if (end === null || every <= 0) return clock.minutes === start;

  // A window that ends before it starts would be a midnight crossing; validation rejects it rather
  // than guessing, so treating it as "no match" here is the fail-closed reading.
  if (end < start) return false;
  if (clock.minutes < start || clock.minutes > end) return false;
  return (clock.minutes - start) % every === 0;
}

/**
 * Did this already fire in the minute `now` falls in?
 *
 * A schedule matches a MINUTE, but the scans that evaluate one run every ten seconds — so without
 * this a matching minute fires six times. The per-automation rate limits (a rule's cooldown, a
 * trigger's min_interval_sec) are user-chosen and may be short or unset, so they cannot be what
 * guarantees this; they are a further limit on top of it.
 *
 * Exact minute equality rather than an elapsed-seconds floor: a one-minute interval puts
 * consecutive firings 55–65 seconds apart depending on where in the minute the tick lands, and a
 * 60-second floor would drop every other one. UTC-based, which is timezone-independent — every
 * zone's minute boundary is the same instant.
 */
export function firedThisMinute(lastFiredAt: Date | null | undefined, now: Date): boolean {
  if (!lastFiredAt) return false;
  return Math.floor(lastFiredAt.getTime() / 60_000) === Math.floor(now.getTime() / 60_000);
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * The one set of rules every writer of a schedule is held to — the user rules API, the pipelines
 * API and blueprint publish all call this, so a schedule that saves in one place cannot be
 * rejected in another.
 *
 * Returns a problem in plain language, or null when the spec is sound.
 */
export function validateSchedule(spec: ScheduleSpec): string | null {
  if (!spec.time) return 'a schedule needs a time (HH:MM)';

  // Either clock may be a reference since F11.14 ("lights off at @phase.light.off_time"). Its value
  // is not knowable here — it depends on the phase the entity is in when it runs — so the checks
  // that compare the two times are skipped for a reference rather than guessed at. What a
  // reference still gets: the structural checks below, and `validateParamRefs` at the caller,
  // which is what catches a key the blueprint never declared.
  const startRef = isParamRef(spec.time);
  const start = startRef ? null : minutesOfDay(spec.time);
  if (!startRef && start === null) return `"${spec.time}" is not a time — use HH:MM`;

  const hasEnd = !!spec.until;
  const hasStep = !!spec.everyMinutes && spec.everyMinutes > 0;
  // Half a window is not a smaller window, it is an unanswerable question: an end with no step
  // does not say how often, and a step with no end does not say until when.
  if (hasEnd !== hasStep) {
    return 'a repeating schedule needs both an end time and an interval';
  }

  if (hasEnd) {
    const endRef = isParamRef(spec.until);
    const end = endRef ? null : minutesOfDay(spec.until);
    if (!endRef && end === null) return `"${spec.until}" is not a time — use HH:MM`;
    if (start !== null && end !== null) {
      // Midnight crossing is rejected rather than guessed: "22:00 to 02:00" could mean four hours
      // or twenty, and a schedule that quietly means the wrong one is worse than one that will not
      // save. A window whose ends are references is checked the same way at run time instead:
      // matchesSchedule simply never matches when the resolved end is not after the start.
      if (end <= start) return 'the end of a window must be later in the day than its start';
      if (spec.everyMinutes! > end - start) {
        return 'the interval is longer than the window — it would fire once, at the start';
      }
    }
  }

  if (spec.days?.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return 'days must be 0 (Sunday) through 6 (Saturday)';
  }
  return null;
}

// ── Description ───────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One-line plain-language rendering, for API messages, logs and audit trails. */
export function describeSchedule(spec: ScheduleSpec): string {
  if (!spec.time) return 'no schedule set';
  const days = spec.days?.length
    ? [...spec.days]
        .sort((a, b) => a - b)
        .map((d) => DAY_NAMES[d] ?? '?')
        .join(', ')
    : 'every day';
  if (spec.until && spec.everyMinutes) {
    return `${days}, ${spec.time}–${spec.until} every ${spec.everyMinutes} min`;
  }
  return `${days} at ${spec.time}`;
}
