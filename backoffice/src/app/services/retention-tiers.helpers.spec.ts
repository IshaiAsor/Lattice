import {
  followsPhrase,
  ladderName,
  scopeLabel,
  tierSummary,
  type BucketView,
} from './retention-tiers.service';

// The two helpers every Data tab reads its sentences from (F18.20). Pure, so no TestBed.

const bucket = (code: string, seconds: number, label: string): BucketView => ({
  code,
  seconds,
  label,
  anchorOffsetSeconds: 0,
  isBuiltin: true,
  createdBy: null,
  createdByUserId: null,
  rowsPerDay: seconds > 0 ? 86_400 / seconds : null,
});

const BUCKETS = [
  bucket('raw', 0, 'Raw readings'),
  bucket('15m', 900, '15 minutes'),
  bucket('1h', 3600, '1 hour'),
  bucket('1d', 86_400, '1 day'),
];

describe('tierSummary', () => {
  it('reads a list in stored order, with forever for 0', () => {
    const summary = tierSummary(
      [
        { bucket: '1d', keepDays: 0, position: 2 },
        { bucket: 'raw', keepDays: 14, position: 0 },
        { bucket: '1h', keepDays: 90, position: 1 },
      ],
      BUCKETS,
    );
    expect(summary).toBe('Raw 14 days · 1 hour 90 days · 1 day forever');
  });

  it('says what an empty list means to the sweep', () => {
    expect(tierSummary([], BUCKETS)).toBe('keep everything');
  });

  it('falls back to the code for a size the catalog does not carry', () => {
    expect(tierSummary([{ bucket: '90m', keepDays: 30, position: 0 }], BUCKETS)).toBe(
      '90m 30 days',
    );
  });
});

describe('scopeLabel', () => {
  it('names the reader’s own list as theirs, not by the action’s name', () => {
    expect(scopeLabel('action')).toBe('Your list');
  });

  it('names every scope', () => {
    expect(
      (['device', 'blueprint', 'sealed', 'user', 'platform'] as const).map(scopeLabel),
    ).toEqual(['This device', 'Blueprint', 'Sealed template', 'Your settings', 'Platform']);
  });

  it('calls the action scope the sensor on the strip, where every step is a thing', () => {
    expect(ladderName('action')).toBe('This sensor');
    expect(ladderName('device')).toBe('This device');
  });
});

describe('followsPhrase', () => {
  it('reads as the object of "follows"', () => {
    expect(`Follows ${followsPhrase('device')}`).toBe('Follows this device');
    expect(`Remove list — follow ${followsPhrase('sealed')}`).toBe(
      'Remove list — follow the sealed template',
    );
  });
});
