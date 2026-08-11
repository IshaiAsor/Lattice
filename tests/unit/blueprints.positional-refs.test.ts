import {
  buildParamContext,
  EMPTY_PARAM_CONTEXT,
  positionalError,
  resolveClock,
  resolveSeconds,
} from '@lattice/params';

// F11.14 — the values *beside* target_state may now be references too: how long the device holds
// the state, how long it waits first, and what time of day a schedule fires.
//
// The point of the feature is that a number belonging to a growth stage lives on the stage. These
// tests pin the two halves that make that safe: a literal still means exactly what it always did
// (so nothing already written changes), and anything unresolvable yields null rather than a guess.

// A pot mid-lifecycle: the phase sets the watering period and the lighting window, and the user has
// overridden the period for this one device.
const potContext = buildParamContext({
  overrides: [{ param_key: 'water.seconds', phase_key: '', value: '120' }],
  defaults: [
    { key: 'water.seconds', default_value: '60' },
    { key: 'light.off_time', default_value: '20:00' },
    { key: 'light.on_time', default_value: '06:00' },
  ],
  currentPhase: {
    key: 'growth',
    name: 'Growth',
    context_notes: null,
    targets: [
      { param_key: 'water.seconds', value: '90' },
      { param_key: 'light.off_time', value: '22:00' },
    ],
  },
});

describe('positional references — seconds (F11.14)', () => {
  it('passes a literal through unchanged, so every pre-F11.14 row keeps its meaning', () => {
    expect(resolveSeconds('90', potContext)).toBe(90);
    expect(resolveSeconds(90, potContext)).toBe(90);
    expect(resolveSeconds('  90  ', potContext)).toBe(90);
  });

  it('resolves a literal with no context at all — a hand-written rule has none', () => {
    expect(resolveSeconds('45')).toBe(45);
    expect(resolveSeconds(45)).toBe(45);
  });

  it('reads a phase reference through the full precedence, so an override wins', () => {
    // override 120 beats the phase target 90 beats the default 60.
    expect(resolveSeconds('@phase.water.seconds', potContext)).toBe(120);
  });

  it('reads a param reference, which ignores the phase target', () => {
    expect(resolveSeconds('@param.water.seconds', potContext)).toBe(120);
  });

  it('falls back to the default when neither an override nor a target sets it', () => {
    const bare = buildParamContext({
      overrides: [],
      defaults: [{ key: 'water.seconds', default_value: '60' }],
      currentPhase: { key: 'growth', name: 'Growth', context_notes: null, targets: [] },
    });
    expect(resolveSeconds('@phase.water.seconds', bare)).toBe(60);
  });

  it('fails closed on a reference with no context, rather than treating it as a literal', () => {
    expect(resolveSeconds('@phase.water.seconds')).toBeNull();
    expect(resolveSeconds('@phase.water.seconds', null)).toBeNull();
    expect(resolveSeconds('@phase.nothing.here', EMPTY_PARAM_CONTEXT)).toBeNull();
  });

  it('fails closed when the reference resolves to something that is not a number', () => {
    const wordy = buildParamContext({
      overrides: [],
      defaults: [{ key: 'water.seconds', default_value: 'a while' }],
      currentPhase: null,
    });
    expect(resolveSeconds('@param.water.seconds', wordy)).toBeNull();
  });

  it('rejects a negative, which firmware would read as an enormous unsigned count', () => {
    expect(resolveSeconds('-5')).toBeNull();
    expect(resolveSeconds(-5)).toBeNull();
  });

  it('floors a fractional value so every caller rounds the same way', () => {
    expect(resolveSeconds('1.9')).toBe(1);
  });

  it('treats absent as absent — the caller supplies "indefinitely" or "now"', () => {
    expect(resolveSeconds(null)).toBeNull();
    expect(resolveSeconds(undefined)).toBeNull();
  });

  it('accepts zero, which is a real delay meaning "publish now"', () => {
    expect(resolveSeconds('0')).toBe(0);
    expect(resolveSeconds(0)).toBe(0);
  });
});

describe('positional references — clock (F11.14)', () => {
  it('passes a literal HH:MM through', () => {
    expect(resolveClock('06:00', potContext)).toBe('06:00');
  });

  it('resolves a phase reference, so lights-off is a property of the stage', () => {
    // The phase says 22:00; the blueprint default says 20:00.
    expect(resolveClock('@phase.light.off_time', potContext)).toBe('22:00');
    expect(resolveClock('@phase.light.on_time', potContext)).toBe('06:00');
  });

  it('normalises a missing leading zero, so 7:30 and 07:30 are the same time', () => {
    const loose = buildParamContext({
      overrides: [],
      defaults: [{ key: 'light.on_time', default_value: '7:30' }],
      currentPhase: null,
    });
    expect(resolveClock('@param.light.on_time', loose)).toBe('07:30');
    expect(resolveClock('7:30')).toBe('07:30');
  });

  it('fails closed on anything that is not a time, so the schedule never fires', () => {
    expect(resolveClock('8pm')).toBeNull();
    expect(resolveClock('25:00')).toBeNull();
    expect(resolveClock('06:99')).toBeNull();
    expect(resolveClock('')).toBeNull();
    expect(resolveClock(null)).toBeNull();
  });

  it('fails closed on an unresolvable reference rather than firing at a default hour', () => {
    expect(resolveClock('@phase.light.off_time')).toBeNull();
    expect(resolveClock('@phase.not.declared', potContext)).toBeNull();
  });
});

// The publish gate's half: catch the literal that is not a value of its kind, because it would
// otherwise publish clean and then fail closed forever.
describe('positional references — publish gate (F11.14)', () => {
  it('accepts a well-formed literal of either kind', () => {
    expect(positionalError('90', 'seconds')).toBeNull();
    expect(positionalError(90, 'seconds')).toBeNull();
    expect(positionalError('20:00', 'clock')).toBeNull();
  });

  it('accepts any well-formed reference — whether the key exists is validateParamRefs’ job', () => {
    expect(positionalError('@phase.water.seconds', 'seconds')).toBeNull();
    expect(positionalError('@param.light.off_time', 'clock')).toBeNull();
  });

  it('accepts absent, since both positions are optional', () => {
    expect(positionalError(null, 'seconds')).toBeNull();
    expect(positionalError(undefined, 'clock')).toBeNull();
    expect(positionalError('', 'clock')).toBeNull();
  });

  it('rejects a unit-suffixed duration, the likeliest way to write one by hand', () => {
    expect(positionalError('60s', 'seconds')).toContain('neither a number');
  });

  it('rejects a negative duration', () => {
    expect(positionalError('-1', 'seconds')).toContain('negative');
  });

  it('rejects a clock that is not HH:MM', () => {
    expect(positionalError('8pm', 'clock')).toContain('neither a HH:MM time');
    expect(positionalError('24:00', 'clock')).toContain('neither a HH:MM time');
  });
});
