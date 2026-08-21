// Unit: automation domain — pure rule-evaluation logic
// (automation-worker/src/services/rules-logic.ts) and the schedule shape every surface shares
// (packages/params/src/schedule.ts).

import {
  compare,
  isCooldownExpired,
  combineConditionOutcomes,
} from '../../services/automation-worker/src/services/rules-logic';
import {
  describeSchedule,
  firedThisMinute,
  matchesSchedule,
  validateSchedule,
  zonedClock,
} from '../../packages/params/src/schedule';

/** The pre-window call, kept as a helper so those cases still read as one line. */
const matchesScheduleAt = (time: string | null, days: number[], now: Date) =>
  matchesSchedule({ time, days }, now);

describe('compare', () => {
  it.each([
    [25, '>', 20, true],
    [15, '>', 20, false],
    [15, '<', 20, true],
    [20, '>=', 20, true],
    [20, '<=', 20, true],
    [19, '<=', 20, true],
    [20, '=', 20, true],
    [21, '=', 20, false],
    [21, '!=', 20, true],
    [20, '!=', 20, false],
  ])('%s %s %s → %s', (a, op, b, expected) => {
    expect(compare(a, op, b)).toBe(expected);
  });

  it('returns false for unknown operators', () => {
    expect(compare(1, '==', 1)).toBe(false); // rules use '=', not '=='
    expect(compare(1, '~', 1)).toBe(false);
  });
});

describe('isCooldownExpired', () => {
  const now = new Date('2026-07-05T12:00:00Z');

  it('is expired when the rule never fired', () => {
    expect(isCooldownExpired(null, 60, now)).toBe(true);
  });

  it('is not expired inside the cooldown window', () => {
    expect(isCooldownExpired(new Date('2026-07-05T11:59:30Z'), 60, now)).toBe(false);
  });

  it('is expired exactly at the cooldown boundary', () => {
    expect(isCooldownExpired(new Date('2026-07-05T11:59:00Z'), 60, now)).toBe(true);
  });

  it('is expired after the window', () => {
    expect(isCooldownExpired(new Date('2026-07-05T11:00:00Z'), 60, now)).toBe(true);
  });

  it('zero cooldown always allows refiring', () => {
    expect(isCooldownExpired(now, 0, now)).toBe(true);
  });
});

describe('matchesScheduleAt', () => {
  // 2026-07-05 is a Sunday (getDay() === 0). Use a local-time Date so HH:MM matches.
  const sundayNoon = new Date(2026, 6, 5, 12, 30);

  it('matches on exact HH:MM with empty days (every day)', () => {
    expect(matchesScheduleAt('12:30', [], sundayNoon)).toBe(true);
  });

  it('does not match a different minute', () => {
    expect(matchesScheduleAt('12:31', [], sundayNoon)).toBe(false);
  });

  it('matches when today is in the days list', () => {
    expect(matchesScheduleAt('12:30', [0, 3], sundayNoon)).toBe(true);
  });

  it('does not match when today is not in the days list', () => {
    expect(matchesScheduleAt('12:30', [1, 2, 3, 4, 5, 6], sundayNoon)).toBe(false);
  });

  it('null time never matches', () => {
    expect(matchesScheduleAt(null, [], sundayNoon)).toBe(false);
  });

  it('pads single-digit hours/minutes (09:05)', () => {
    expect(matchesScheduleAt('09:05', [], new Date(2026, 6, 5, 9, 5))).toBe(true);
  });
});

// A window turns a schedule from one minute a day into a loop — "06:00 to 17:30, every 10 minutes",
// the shape a working day of short runs needs. How long the device then stays on is the action's
// own `duration_seconds`, not part of this, so these only pin WHEN it fires.
describe('matchesSchedule — window + interval', () => {
  const at = (h: number, m: number) => new Date(2026, 6, 6, h, m); // a Monday
  const loop = { time: '06:00', until: '17:30', everyMinutes: 10, days: [] };

  it('fires at the start of a window', () => {
    expect(matchesSchedule(loop, at(6, 0))).toBe(true);
  });

  it('fires at each interval inside the window', () => {
    expect(matchesSchedule(loop, at(6, 10))).toBe(true);
    expect(matchesSchedule(loop, at(12, 30))).toBe(true);
  });

  it('does not fire between intervals', () => {
    expect(matchesSchedule(loop, at(6, 5))).toBe(false);
    expect(matchesSchedule(loop, at(12, 34))).toBe(false);
  });

  it('fires on the closing minute when it lands on the interval', () => {
    // 17:30 is 690 minutes after 06:00 — exactly 69 intervals, so the window is inclusive.
    expect(matchesSchedule(loop, at(17, 30))).toBe(true);
  });

  it('does not fire past the end of the window', () => {
    expect(matchesSchedule(loop, at(17, 40))).toBe(false);
    expect(matchesSchedule(loop, at(23, 0))).toBe(false);
  });

  it('does not fire before the window opens', () => {
    expect(matchesSchedule(loop, at(5, 50))).toBe(false);
  });

  it('ignores the window when the interval is zero', () => {
    // Half a window is not a window: fall back to the exact-minute shape rather than guessing.
    const spec = { time: '06:00', until: '17:30', everyMinutes: 0, days: [] };
    expect(matchesSchedule(spec, at(6, 0))).toBe(true);
    expect(matchesSchedule(spec, at(6, 10))).toBe(false);
  });

  it('ignores the interval when no end is given', () => {
    const spec = { time: '06:00', until: null, everyMinutes: 10, days: [] };
    expect(matchesSchedule(spec, at(6, 0))).toBe(true);
    expect(matchesSchedule(spec, at(6, 10))).toBe(false);
  });

  it('refuses a window that ends before it starts', () => {
    // A midnight crossing. Publish validation rejects it; here it simply never matches, so a row
    // that somehow reaches evaluation fails closed instead of firing all night.
    const spec = { time: '22:00', until: '02:00', everyMinutes: 30, days: [] };
    expect(matchesSchedule(spec, at(23, 0))).toBe(false);
    expect(matchesSchedule(spec, at(1, 0))).toBe(false);
  });

  it('still honours the days list inside a window', () => {
    const weekdays = { ...loop, days: [1, 2, 3, 4, 5] };
    expect(matchesSchedule(weekdays, at(12, 30))).toBe(true); // Monday
    expect(matchesSchedule(weekdays, new Date(2026, 6, 5, 12, 30))).toBe(false); // Sunday
  });

  it('rejects a malformed time', () => {
    expect(
      matchesSchedule({ time: '25:00', until: null, everyMinutes: 0, days: [] }, at(6, 0)),
    ).toBe(false);
    expect(
      matchesSchedule({ time: 'noon', until: null, everyMinutes: 0, days: [] }, at(6, 0)),
    ).toBe(false);
  });
});

// A schedule is a sentence about the OWNER's day. Evaluated without a zone it used the evaluating
// process's own — UTC in a container — so "06:00" fired at 09:00 in Israel. These pin the fix by
// asserting on absolute instants, which makes them independent of the machine running them.
describe('matchesSchedule — timezone', () => {
  // 2026-07-06T03:00:00Z is 06:00 in Asia/Jerusalem (UTC+3) and 04:00 in London (UTC+1), on a Monday.
  const instant = new Date('2026-07-06T03:00:00Z');

  it('fires at the local time of the given zone', () => {
    expect(matchesSchedule({ time: '06:00', days: [] }, instant, 'Asia/Jerusalem')).toBe(true);
  });

  it('does not fire at that wall time in another zone', () => {
    expect(matchesSchedule({ time: '06:00', days: [] }, instant, 'Europe/London')).toBe(false);
    expect(matchesSchedule({ time: '04:00', days: [] }, instant, 'Europe/London')).toBe(true);
  });

  it('reads UTC when the zone is UTC', () => {
    expect(matchesSchedule({ time: '03:00', days: [] }, instant, 'UTC')).toBe(true);
  });

  it('takes the day of week from the zone, not from UTC', () => {
    // 2026-07-06T23:30:00Z is Monday in UTC but already Tuesday in Tokyo (08:30, UTC+9).
    const lateMonday = new Date('2026-07-06T23:30:00Z');
    expect(matchesSchedule({ time: '08:30', days: [2] }, lateMonday, 'Asia/Tokyo')).toBe(true);
    expect(matchesSchedule({ time: '08:30', days: [1] }, lateMonday, 'Asia/Tokyo')).toBe(false);
  });

  it('applies the zone to a window as well as a single time', () => {
    const loop = { time: '06:00', until: '17:30', everyMinutes: 10, days: [] };
    expect(matchesSchedule(loop, instant, 'Asia/Jerusalem')).toBe(true);
    expect(matchesSchedule(loop, instant, 'UTC')).toBe(false); // 03:00 UTC is before the window
  });

  it('falls back to the server zone for an unknown name rather than never firing', () => {
    // An ICU update can retire a zone name. A schedule that silently stops is worse than one
    // evaluated where the server is, which is exactly the old behaviour.
    const localSix = new Date(2026, 6, 6, 6, 0);
    expect(matchesSchedule({ time: '06:00', days: [] }, localSix, 'Mars/Olympus')).toBe(true);
  });

  it('handles midnight without reporting hour 24', () => {
    // en-US with hour12:false renders midnight as "24" in some ICU versions; 24:00 would never match.
    const midnightJerusalem = new Date('2026-07-05T21:00:00Z');
    expect(zonedClock(midnightJerusalem, 'Asia/Jerusalem').minutes).toBe(0);
    expect(matchesSchedule({ time: '00:00', days: [] }, midnightJerusalem, 'Asia/Jerusalem')).toBe(
      true,
    );
  });
});

// One validator for the rules API, the pipelines API and blueprint publish — a schedule that saves
// on one surface must not be rejected on another.
describe('validateSchedule', () => {
  it('accepts a single time', () => {
    expect(validateSchedule({ time: '06:00', days: [] })).toBeNull();
  });

  it('accepts a full window', () => {
    expect(
      validateSchedule({ time: '06:00', until: '17:30', everyMinutes: 10, days: [1, 2] }),
    ).toBeNull();
  });

  it('rejects a missing or malformed time', () => {
    expect(validateSchedule({ time: null, days: [] })).toMatch(/needs a time/);
    expect(validateSchedule({ time: '25:00', days: [] })).toMatch(/not a time/);
  });

  it('rejects half a window, in both directions', () => {
    expect(validateSchedule({ time: '06:00', until: '17:30', days: [] })).toMatch(/both/);
    expect(validateSchedule({ time: '06:00', everyMinutes: 10, days: [] })).toMatch(/both/);
  });

  it('rejects a window that ends before it starts', () => {
    expect(validateSchedule({ time: '22:00', until: '02:00', everyMinutes: 30, days: [] })).toMatch(
      /later in the day/,
    );
  });

  it('rejects an interval longer than the window', () => {
    expect(validateSchedule({ time: '06:00', until: '07:00', everyMinutes: 90, days: [] })).toMatch(
      /longer than the window/,
    );
  });

  it('rejects an out-of-range day', () => {
    expect(validateSchedule({ time: '06:00', days: [7] })).toMatch(/0 \(Sunday\)/);
  });
});

// A schedule matches a MINUTE while the scans run every ten seconds, so without this one matching
// minute fires six times.
describe('firedThisMinute', () => {
  const now = new Date('2026-07-06T06:00:55Z');

  it('is false when it has never fired', () => {
    expect(firedThisMinute(null, now)).toBe(false);
  });

  it('is true earlier in the same minute', () => {
    expect(firedThisMinute(new Date('2026-07-06T06:00:05Z'), now)).toBe(true);
  });

  it('is false in the previous minute, even 10 seconds ago', () => {
    // The case an elapsed-seconds floor gets wrong: 55s apart, but a different minute, so a
    // one-minute interval must be allowed to fire.
    expect(firedThisMinute(new Date('2026-07-06T05:59:59Z'), now)).toBe(false);
  });
});

describe('describeSchedule', () => {
  it('reads a single time', () => {
    expect(describeSchedule({ time: '06:00', days: [] })).toBe('every day at 06:00');
  });

  it('reads a window', () => {
    expect(
      describeSchedule({ time: '06:00', until: '17:30', everyMinutes: 10, days: [1, 5] }),
    ).toBe('Mon, Fri, 06:00–17:30 every 10 min');
  });

  it('says so when there is no schedule', () => {
    expect(describeSchedule({ time: null, days: [] })).toBe('no schedule set');
  });
});

describe('combineConditionOutcomes', () => {
  const met = (observed: string | null = null) => ({ met: true, observed });
  const notMet = (observed: string | null = null) => ({ met: false, observed });

  it('AND fires only when every condition is met', () => {
    expect(combineConditionOutcomes('AND', [met(), met()]).triggered).toBe(true);
    expect(combineConditionOutcomes('AND', [met(), notMet()]).triggered).toBe(false);
  });

  it('OR fires when any condition is met', () => {
    expect(combineConditionOutcomes('OR', [notMet(), met()]).triggered).toBe(true);
    expect(combineConditionOutcomes('OR', [notMet(), notMet()]).triggered).toBe(false);
  });

  it('records the reading from the condition that passed', () => {
    // The whole point of the value: it must explain why THIS rule fired.
    expect(combineConditionOutcomes('OR', [notMet('99'), met('21.5')]).triggeredValue).toBe('21.5');
  });

  it('ignores readings from conditions that did not pass', () => {
    expect(combineConditionOutcomes('AND', [met('21.5'), notMet('99')]).triggeredValue).toBe(null);
  });

  it('reports no value when the passing conditions observed nothing', () => {
    // A schedule rule fires on a clock, not a reading — there is no honest value to record.
    expect(combineConditionOutcomes('AND', [met(), met()]).triggeredValue).toBe(null);
  });

  it('takes the first passing condition that observed something', () => {
    expect(combineConditionOutcomes('AND', [met(), met('7'), met('9')]).triggeredValue).toBe('7');
  });

  it('does not fire a rule that has no conditions at all', () => {
    // `[].every()` is true, so without this guard a conditionless AND rule fires every pass.
    expect(combineConditionOutcomes('AND', []).triggered).toBe(false);
  });
});
