import {
  accruedOnEnter,
  isPhaseDue,
  phaseDurationSeconds,
  phaseElapsedSeconds,
  secondsBetween,
} from '@lattice/params';
import { nextPhase } from '../../services/automation-worker/src/services/phases-logic';

// F10.4 / F10.12 — the arithmetic behind blueprint phase auto-advance and the per-phase time bank.
// Pure, so the cron's decision is testable without a stack or a two-day wait.
//
// The timing half lives in @lattice/params rather than the worker because api renders the same
// countdown the cron acts on; these tests are the guard on that single definition.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('blueprints — phase schedule (F10.4)', () => {
  describe('phaseDurationSeconds', () => {
    it('converts each supported unit to seconds', () => {
      expect(phaseDurationSeconds(30, 'seconds')).toBe(30);
      expect(phaseDurationSeconds(15, 'minutes')).toBe(15 * MINUTE);
      expect(phaseDurationSeconds(3, 'hours')).toBe(3 * HOUR);
      expect(phaseDurationSeconds(2, 'days')).toBe(2 * DAY);
      expect(phaseDurationSeconds(1, 'weeks')).toBe(7 * DAY);
      // A month is a fixed 30-day approximation, so it stays predictable regardless of calendar.
      expect(phaseDurationSeconds(2, 'months')).toBe(60 * DAY);
    });

    it('returns null for an unknown unit rather than guessing one', () => {
      expect(phaseDurationSeconds(5, 'fortnights')).toBeNull();
      expect(phaseDurationSeconds(5, null)).toBeNull();
    });

    it('treats a missing, zero or negative value as no duration', () => {
      expect(phaseDurationSeconds(null, 'days')).toBeNull();
      expect(phaseDurationSeconds(0, 'days')).toBeNull();
      expect(phaseDurationSeconds(-1, 'days')).toBeNull();
    });
  });

  describe('isPhaseDue', () => {
    const base = {
      auto_advance: true,
      duration_value: 2,
      duration_unit: 'days',
      phase_started_at: new Date('2026-07-01T00:00:00Z'),
      accrued_seconds: 0,
      hasNextPhase: true,
    };

    it('is due once the full duration has elapsed', () => {
      expect(isPhaseDue(base, new Date('2026-07-03T00:00:00Z'))).toBe(true);
    });

    it('is due when the duration is overshot, so a downtime gap still advances', () => {
      expect(isPhaseDue(base, new Date('2026-07-30T00:00:00Z'))).toBe(true);
    });

    it('is not due one second early', () => {
      expect(isPhaseDue(base, new Date('2026-07-02T23:59:59Z'))).toBe(false);
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

    // ── Banked time (F10.12) ────────────────────────────────────────────
    //
    // A resumed phase is already part-way through. If these regress, the instance page's countdown
    // and the cron stop agreeing, which is the failure the shared module exists to prevent.

    it('counts banked time, so a resumed phase fires early by exactly what it banked', () => {
      // 2-day phase resumed 1 day in ⇒ due after 1 more day, not 2.
      const resumed = { ...base, accrued_seconds: DAY };
      expect(isPhaseDue(resumed, new Date('2026-07-01T23:59:59Z'))).toBe(false);
      expect(isPhaseDue(resumed, new Date('2026-07-02T00:00:00Z'))).toBe(true);
    });

    it('is due on the spot when the bank already covers the duration', () => {
      // The user was warned and chose it anyway — the next tick moves it on.
      expect(isPhaseDue({ ...base, accrued_seconds: 5 * DAY }, base.phase_started_at)).toBe(true);
    });

    it('ignores a bank on a phase that never elapses, rather than inventing a deadline', () => {
      expect(
        isPhaseDue(
          { ...base, duration_value: null, accrued_seconds: 99 * DAY },
          new Date('2026-08-30T00:00:00Z'),
        ),
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

describe('blueprints — phase time bank (F10.12)', () => {
  describe('secondsBetween', () => {
    it('floors to whole seconds', () => {
      expect(
        secondsBetween(new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:01.999Z')),
      ).toBe(1);
    });

    it('never returns a negative, so a clock stepping back cannot credit unspent time', () => {
      expect(
        secondsBetween(new Date('2026-07-02T00:00:00Z'), new Date('2026-07-01T00:00:00Z')),
      ).toBe(0);
    });
  });

  describe('phaseElapsedSeconds', () => {
    const now = new Date('2026-07-10T00:00:00Z');

    it('adds the live run to the bank for the phase in flight', () => {
      expect(phaseElapsedSeconds(3 * DAY, new Date('2026-07-09T00:00:00Z'), now)).toBe(4 * DAY);
    });

    it('is the bank alone for a phase not currently running', () => {
      expect(phaseElapsedSeconds(3 * DAY, null, now)).toBe(3 * DAY);
    });

    it('treats a missing or negative bank as zero', () => {
      expect(phaseElapsedSeconds(-5, null, now)).toBe(0);
      expect(phaseElapsedSeconds(0, new Date('2026-07-09T00:00:00Z'), now)).toBe(DAY);
    });
  });

  describe('accruedOnEnter', () => {
    it('reset discards the bank — what the cron always does', () => {
      expect(accruedOnEnter('reset', 3 * DAY, 99)).toBe(0);
    });

    it('resume keeps the bank, which is what makes a rollback an undo', () => {
      expect(accruedOnEnter('resume', 3 * DAY, 99)).toBe(3 * DAY);
    });

    it('at takes the requested value and ignores the bank', () => {
      expect(accruedOnEnter('at', 3 * DAY, 2 * DAY)).toBe(2 * DAY);
    });

    it('floors a fractional request and refuses a negative one', () => {
      expect(accruedOnEnter('at', 0, 90.7)).toBe(90);
      expect(accruedOnEnter('at', 0, -1)).toBe(0);
    });

    it('clamps to what the column can hold rather than overflowing it', () => {
      expect(accruedOnEnter('at', 0, 9e12)).toBe(2147483647);
    });
  });
});
