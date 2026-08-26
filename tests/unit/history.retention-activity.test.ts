import {
  diffTiers,
  describeChange,
  isDestructive,
  summarizeTierChanges,
  summarizeCeilingChanges,
  ceilingLowered,
  formatKeep,
  formatCeiling,
  type Tier,
} from '@lattice/retention';

// The audit trail's "how" (F18.19): turning two tier lists into the sentence the log stores.
//
// This is worth testing on its own because the two encodings that run through the whole feature are
// both COUNTERINTUITIVE, and this module is where they meet a comparison operator: on a keep window
// `0` means FOREVER (so it is the largest value while being the smallest number), and on a ceiling
// `null` means UNCAPPED (so it is larger than any number). A naive `<` gets both backwards, and the
// consequence is an audit entry that describes a change in the wrong direction — worse than no
// entry, because it will be believed.

const t = (bucket: string, keepDays: number, position = 0): Tier => ({
  bucket,
  keepDays,
  position,
});

describe('history.retention-activity', () => {
  it('reports an added tier, a removed tier and a changed window', () => {
    const before = [t('raw', 14), t('1h', 90)];
    const after = [t('raw', 7), t('15m', 30)];
    const changes = diffTiers(before, after);

    expect(changes).toEqual(
      expect.arrayContaining([
        { bucket: 'raw', kind: 'changed', fromDays: 14, toDays: 7 },
        { bucket: '15m', kind: 'added', fromDays: null, toDays: 30 },
        { bucket: '1h', kind: 'removed', fromDays: 90, toDays: null },
      ]),
    );
    expect(changes).toHaveLength(3);
  });

  it('ignores a reordering that leaves every window untouched', () => {
    // Position is derived from bucket size at read time, so a reorder is not a retention change and
    // must not fill the log with entries that changed nothing.
    const before = [t('raw', 7, 0), t('1h', 30, 1)];
    const after = [t('1h', 30, 0), t('raw', 7, 1)];
    expect(diffTiers(before, after)).toEqual([]);
    expect(summarizeTierChanges(diffTiers(before, after))).toBe('no change');
  });

  it('treats forever → a finite window as destructive, and the reverse as not', () => {
    const shortened = diffTiers([t('raw', 0)], [t('raw', 3650)])[0]!;
    const extended = diffTiers([t('raw', 3650)], [t('raw', 0)])[0]!;

    // 0 → 3650 is numerically an increase and is still a loss of data.
    expect(isDestructive(shortened)).toBe(true);
    expect(isDestructive(extended)).toBe(false);
  });

  it('leads the summary with the destructive changes', () => {
    // Someone scanning a year of entries for "when did we start losing data" must not have to read
    // past the harmless additions.
    const changes = diffTiers(
      [t('raw', 30), t('1h', 365)],
      [t('raw', 7), t('1h', 365), t('1d', 0)],
    );
    expect(summarizeTierChanges(changes)).toBe('raw 30d → 7d, added 1d kept forever');
  });

  it('counts the remainder instead of truncating a phrase mid-word', () => {
    const before = [t('raw', 30)];
    const after = [
      t('raw', 30),
      t('5m', 1),
      t('15m', 2),
      t('30m', 3),
      t('1h', 4),
      t('6h', 5),
      t('1d', 6),
    ];
    const summary = summarizeTierChanges(diffTiers(before, after), 2);
    expect(summary).toMatch(/\(\+4 more\)$/);
    expect(summary.length).toBeLessThanOrEqual(400);
  });

  it('describes a ceiling move using uncapped rather than null', () => {
    const before = new Map<string, number | null>([['raw', null]]);
    const after = new Map<string, number | null>([['raw', 30]]);
    expect(summarizeCeilingChanges(before, after)).toBe('raw ceiling uncapped → 30d');
  });

  it('recognises uncapped → capped and forever → capped as lowerings', () => {
    // Both are the F18.16 case: users may now be over a ceiling that did not previously bind them.
    expect(ceilingLowered(null, 30)).toBe(true);
    expect(ceilingLowered(0, 30)).toBe(true);
    expect(ceilingLowered(365, 30)).toBe(true);
  });

  it('does not treat raising or removing a ceiling as a lowering', () => {
    expect(ceilingLowered(30, null)).toBe(false);
    expect(ceilingLowered(30, 0)).toBe(false);
    expect(ceilingLowered(30, 365)).toBe(false);
    expect(ceilingLowered(30, 30)).toBe(false);
  });

  it('formats windows in the vocabulary the rest of the feature uses', () => {
    expect(formatKeep(0)).toBe('forever');
    expect(formatKeep(365)).toBe('1y');
    expect(formatKeep(730)).toBe('2y');
    expect(formatKeep(7)).toBe('7d');
    expect(formatCeiling(null)).toBe('uncapped');
    expect(formatCeiling(0)).toBe('forever');
  });

  it('phrases each kind of change as its own clause', () => {
    expect(describeChange({ bucket: '15m', kind: 'added', fromDays: null, toDays: 30 })).toBe(
      'added 15m kept 30d',
    );
    expect(describeChange({ bucket: '1h', kind: 'removed', fromDays: 90, toDays: null })).toBe(
      'removed 1h',
    );
    expect(describeChange({ bucket: 'raw', kind: 'changed', fromDays: 14, toDays: 7 })).toBe(
      'raw 14d → 7d',
    );
  });
});
