// Unit: how stored history adds up (@lattice/retention) — F18.22.
//
// The storage panel was wrong for a release, and wrong in a way no test could have caught because
// there was nothing to catch: its per-kind total was computed from the RAW table while the rollup
// tables sat uncounted beside it. So the one figure retention is judged by omitted every row
// retention itself CREATES, and it hid the trade a tier list exists to make — raw shrinks, rollups
// grow. On the dev stack that was 3,138 unreported rows under a headline claiming to be the whole
// of it.
//
// The fix is structural rather than arithmetical: a kind's total is SUMMED from its breakdown
// instead of computed alongside it, so there is nowhere for an omitted part to hide. That is the
// invariant pinned here.

import {
  AVAILABILITY_BYTES,
  COMMAND_BYTES,
  COMMAND_ROLLUP_BYTES,
  EVENT_BYTES,
  READING_BYTES,
  ROLLUP_BYTES,
  sumUsage,
  type UsageBucket,
} from '../../packages/retention/src';

const est = (rows: number, perRow: number): UsageBucket => ({
  rows,
  bytes: rows * perRow,
  estimated: true,
});

describe('totalling a kind from its buckets', () => {
  it('counts the summaries as well as the readings they came from', () => {
    // The exact shape the panel was missing: raw plus three rollup tiers.
    const total = sumUsage({
      raw: est(92_463, READING_BYTES),
      '5m': est(2_332, ROLLUP_BYTES),
      '1h': est(270, ROLLUP_BYTES),
      '1d': est(72, ROLLUP_BYTES),
    });
    expect(total.rows).toBe(92_463 + 2_332 + 270 + 72);
    expect(total.bytes).toBe(92_463 * READING_BYTES + 2_674 * ROLLUP_BYTES);
  });

  it('counts a daily rollup table under its own bucket', () => {
    // command_rollup_daily and device_availability_daily are DATE-keyed, so one row is one day and
    // the whole count belongs to `1d` whatever the tier list says.
    const commands = sumUsage({
      raw: est(8_748, COMMAND_BYTES),
      '1d': est(31, COMMAND_ROLLUP_BYTES),
    });
    expect(commands.buckets['1d']!.rows).toBe(31);
    expect(commands.rows).toBe(8_779);
  });

  it('keeps the breakdown beside the total, so the two cannot disagree', () => {
    const events = sumUsage({ raw: est(10, EVENT_BYTES), '1d': est(28, AVAILABILITY_BYTES) });
    const fromParts = Object.values(events.buckets).reduce((n, b) => n + b.bytes, 0);
    expect(events.bytes).toBe(fromParts);
  });

  it('calls a kind measured only when every part of it is', () => {
    // Frames are the one measured figure in the feature: `byte_size` is recorded at write time.
    const frames = sumUsage({ raw: { rows: 175_244, bytes: 853_540_000, estimated: false } });
    expect(frames.estimated).toBe(false);
  });

  it('calls a kind estimated as soon as any part of it is', () => {
    // Rounding this label the other way would make the one honest figure in the feature dishonest.
    const mixed = sumUsage({
      raw: { rows: 100, bytes: 4_800, estimated: false },
      '1h': est(10, ROLLUP_BYTES),
    });
    expect(mixed.estimated).toBe(true);
  });

  it('totals an empty breakdown to nothing rather than to NaN', () => {
    const empty = sumUsage({});
    expect(empty.rows).toBe(0);
    expect(empty.bytes).toBe(0);
    // Nothing measured is not a measurement.
    expect(empty.estimated).toBe(false);
  });

  it('prices a summary row above the reading it summarises', () => {
    // Not decoration: it is why a 5m tier only pays for itself once a sensor reports more often
    // than every ~7 minutes, which is exactly what the per-bucket figures let someone see.
    expect(ROLLUP_BYTES).toBeGreaterThan(READING_BYTES);
  });
});
