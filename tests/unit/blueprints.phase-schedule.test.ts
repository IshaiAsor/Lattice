import {
  phaseDurationMs,
  isPhaseDue,
  nextPhase,
} from '../../services/automation-worker/src/services/phases-logic';

// F10.4 — the arithmetic behind blueprint phase auto-advance. Pure, so the cron's decision is
// testable without a stack or a two-day wait.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('blueprints — phase schedule (F10.4)', () => {
  describe('phaseDurationMs', () => {
    it('converts each supported unit to milliseconds', () => {
      expect(phaseDurationMs(30, 'seconds')).toBe(30 * SECOND);
      expect(phaseDurationMs(15, 'minutes')).toBe(15 * MINUTE);
      expect(phaseDurationMs(3, 'hours')).toBe(3 * HOUR);
      expect(phaseDurationMs(2, 'days')).toBe(2 * DAY);
      expect(phaseDurationMs(1, 'weeks')).toBe(7 * DAY);
      // A month is a fixed 30-day approximation, so it stays predictable regardless of calendar.
      expect(phaseDurationMs(2, 'months')).toBe(60 * DAY);
    });

    it('returns null for an unknown unit rather than guessing one', () => {
      expect(phaseDurationMs(5, 'fortnights')).toBeNull();
      expect(phaseDurationMs(5, null)).toBeNull();
    });

    it('treats a missing, zero or negative value as no duration', () => {
      expect(phaseDurationMs(null, 'days')).toBeNull();
      expect(phaseDurationMs(0, 'days')).toBeNull();
      expect(phaseDurationMs(-1, 'days')).toBeNull();
    });
  });

  describe('isPhaseDue', () => {
    const base = {
      auto_advance: true,
      duration_value: 2,
      duration_unit: 'days',
      phase_started_at: new Date('2026-07-01T00:00:00Z'),
      hasNextPhase: true,
    };

    it('is due once the full duration has elapsed', () => {
      expect(isPhaseDue(base, new Date('2026-07-03T00:00:00Z'))).toBe(true);
    });

    it('is due when the duration is overshot, so a downtime gap still advances', () => {
      expect(isPhaseDue(base, new Date('2026-07-30T00:00:00Z'))).toBe(true);
    });

    it('is not due one millisecond early', () => {
      expect(isPhaseDue(base, new Date('2026-07-02T23:59:59.999Z'))).toBe(false);
    });

    it('is never due for a phase that did not opt in to auto-advance', () => {
      expect(isPhaseDue({ ...base, auto_advance: false }, new Date('2026-07-30T00:00:00Z'))).toBe(
        false,
      );
    });

    it('is never due for the last phase — a terminal phase is a resting state, not an error', () => {
      expect(isPhaseDue({ ...base, hasNextPhase: false }, new Date('2026-07-30T00:00:00Z'))).toBe(
        false,
      );
    });

    it('is never due when the phase was never entered', () => {
      expect(
        isPhaseDue({ ...base, phase_started_at: null }, new Date('2026-07-30T00:00:00Z')),
      ).toBe(false);
    });

    it('is never due when the duration is missing or unparseable', () => {
      expect(isPhaseDue({ ...base, duration_value: null }, new Date('2026-07-30T00:00:00Z'))).toBe(
        false,
      );
      expect(
        isPhaseDue({ ...base, duration_unit: 'centuries' }, new Date('2026-07-30T00:00:00Z')),
      ).toBe(false);
    });
  });

  describe('nextPhase', () => {
    const phases = [{ ordinal: 10 }, { ordinal: 20 }, { ordinal: 30 }];

    it('picks the next-highest ordinal, not ordinal + 1', () => {
      expect(nextPhase(phases, 10)).toEqual({ ordinal: 20 });
      expect(nextPhase(phases, 20)).toEqual({ ordinal: 30 });
    });

    it('skips a gap left by a phase removed in a later blueprint version', () => {
      expect(nextPhase([{ ordinal: 1 }, { ordinal: 3 }], 1)).toEqual({ ordinal: 3 });
    });

    it('returns null from the last phase', () => {
      expect(nextPhase(phases, 30)).toBeNull();
    });

    it('returns null when the current ordinal is past every declared phase', () => {
      expect(nextPhase(phases, 99)).toBeNull();
    });

    it('is order-independent — it sorts rather than trusting the query order', () => {
      expect(nextPhase([{ ordinal: 30 }, { ordinal: 10 }, { ordinal: 20 }], 10)).toEqual({
        ordinal: 20,
      });
    });
  });
});
