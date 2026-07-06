// Unit: automation domain — pure rule-evaluation logic
// (automation-worker/src/services/rules-logic.ts).

import {
  compare,
  isCooldownExpired,
  matchesScheduleAt,
} from '../../services/automation-worker/src/services/rules-logic';

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
