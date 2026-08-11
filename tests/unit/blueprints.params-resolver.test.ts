// Blueprints (F10.1): the `@param.` / `@phase.` reference grammar in `@lattice/params`.
//
// This is the contract three services depend on — automation-worker resolves thresholds,
// api validates on write, ml-router resolves sensor bounds and prompt text. The precedence
// (phase override → all-phases override → phase target → default) is what lets reconcile, phase
// advance and user tuning coexist, so it is pinned here rather than left to each caller.

import {
  ParamContext,
  EMPTY_PARAM_CONTEXT,
  buildParamContext,
  resolveParamWithSource,
  findParamRefs,
  isParamRef,
  parseParamRef,
  resolveParam,
  resolveText,
  validateParamKey,
  validateParamRefs,
} from '../../packages/params/src';

const ctx = (over: Partial<ParamContext> = {}): ParamContext => ({
  phaseOverrides: {},
  overrides: {},
  phaseTargets: {},
  defaults: {},
  phase: null,
  ...over,
});

const seedling = ctx({
  phaseTargets: { 'humidity.min': '60', 'humidity.max': '80' },
  defaults: { 'humidity.min': '40', 'humidity.max': '70', 'tank.min_level': '20' },
  phase: { key: 'seedling', name: 'Seedling', context_notes: 'Keep humidity high.' },
});

describe('parameter references — grammar', () => {
  it('recognises a whole-value reference', () => {
    expect(isParamRef('@phase.humidity.min')).toBe(true);
    expect(isParamRef('@param.tank.min_level')).toBe(true);
  });

  it('treats a literal as a literal', () => {
    expect(isParamRef('40')).toBe(false);
    expect(isParamRef('ON')).toBe(false);
    expect(isParamRef(null)).toBe(false);
  });

  it('rejects a reference with text around it as a whole-value reference', () => {
    expect(isParamRef('below @phase.humidity.min')).toBe(false);
  });

  it('parses kind and dotted key', () => {
    expect(parseParamRef('@phase.humidity.min')).toEqual({
      kind: 'phase',
      key: 'humidity.min',
      raw: '@phase.humidity.min',
    });
  });

  it('does not swallow a trailing full stop', () => {
    expect(findParamRefs('now in @phase.name. Next up:').map((r) => r.key)).toEqual(['name']);
  });

  it('finds every reference embedded in free text', () => {
    const refs = findParamRefs(
      '@phase.name — floor @phase.humidity.min, tank @param.tank.min_level',
    );
    expect(refs.map((r) => r.raw)).toEqual([
      '@phase.name',
      '@phase.humidity.min',
      '@param.tank.min_level',
    ]);
  });
});

describe('parameter references — resolution precedence', () => {
  it('resolves a phase reference to the current phase target', () => {
    expect(resolveParam('@phase.humidity.min', seedling)).toBe('60');
  });

  it('lets a user override beat the phase target', () => {
    const withOverride = { ...seedling, overrides: { 'humidity.min': '50' } };
    expect(resolveParam('@phase.humidity.min', withOverride)).toBe('50');
  });

  it('falls back to the blueprint default when the phase sets no target', () => {
    expect(resolveParam('@phase.tank.min_level', seedling)).toBe('20');
  });

  it('ignores the phase target for a @param reference', () => {
    expect(resolveParam('@param.humidity.min', seedling)).toBe('40');
  });

  it('lets a user override beat the default for a @param reference', () => {
    const withOverride = { ...seedling, overrides: { 'humidity.min': '50' } };
    expect(resolveParam('@param.humidity.min', withOverride)).toBe('50');
  });

  it('passes a literal through untouched', () => {
    expect(resolveParam('40', seedling)).toBe('40');
    expect(resolveParam('ON', seedling)).toBe('ON');
  });

  it('resolves an unknown parameter to null so the caller fails closed', () => {
    expect(resolveParam('@phase.nonexistent', seedling)).toBeNull();
  });

  it('resolves against an empty context to null, never to the raw reference', () => {
    expect(resolveParam('@phase.humidity.min', ctx())).toBeNull();
  });
});

describe('parameter references — phase metadata', () => {
  it('resolves @phase.name and @phase.key to the current phase', () => {
    expect(resolveParam('@phase.name', seedling)).toBe('Seedling');
    expect(resolveParam('@phase.key', seedling)).toBe('seedling');
  });

  it('resolves absent context notes to an empty string, not null', () => {
    const noNotes = { ...seedling, phase: { key: 'mature', name: 'Mature' } };
    expect(resolveParam('@phase.context_notes', noNotes)).toBe('');
  });

  it('resolves phase metadata to null when the instance has no current phase', () => {
    expect(resolveParam('@phase.name', ctx())).toBeNull();
  });

  it('does not let an override shadow phase metadata', () => {
    const shadowed = { ...seedling, overrides: { name: 'Hacked' } };
    expect(resolveParam('@phase.name', shadowed)).toBe('Seedling');
  });
});

describe('parameter references — text interpolation', () => {
  it('substitutes references inside a prompt template', () => {
    const out = resolveText(
      'This setup is in its @phase.name phase. @phase.context_notes Floor: @phase.humidity.min%.',
      seedling,
    );
    expect(out.text).toBe('This setup is in its Seedling phase. Keep humidity high. Floor: 60%.');
    expect(out.unresolved).toEqual([]);
  });

  it('drops an unresolvable reference from the text and reports it', () => {
    const out = resolveText('Floor is @phase.nope today', seedling);
    expect(out.text).toBe('Floor is  today');
    expect(out.unresolved).toEqual(['@phase.nope']);
  });

  it('leaves text with no references untouched', () => {
    expect(resolveText('Assess the reading.', seedling).text).toBe('Assess the reading.');
  });
});

describe('parameter references — write-time validation', () => {
  it('accepts a reference to a declared parameter', () => {
    expect(validateParamRefs('@phase.humidity.min', ['humidity.min'])).toEqual([]);
  });

  it('rejects a reference to an undeclared parameter and names it', () => {
    const errors = validateParamRefs('@phase.humidty.min', ['humidity.min']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('humidty.min');
  });

  it('accepts phase metadata without it being a declared parameter', () => {
    expect(validateParamRefs('in @phase.name now', [])).toEqual([]);
  });

  it('validates every reference embedded in free text', () => {
    expect(validateParamRefs('@phase.a and @param.b', ['a'])).toHaveLength(1);
  });

  it('accepts a literal with no references', () => {
    expect(validateParamRefs('40', [])).toEqual([]);
  });

  it('rejects a parameter key that collides with phase metadata', () => {
    expect(validateParamKey('name')).toContain('reserved');
  });

  it('rejects a malformed parameter key', () => {
    expect(validateParamKey('humidity min')).toContain('not a valid');
  });

  it('accepts a dotted parameter key', () => {
    expect(validateParamKey('humidity.min')).toBeNull();
  });
});

// The shaping half of the contract: every service queries the instance its own way, but all three
// must assemble the three layers identically — otherwise the instance page shows a value the
// rules never act on.
describe('parameter references — context assembly', () => {
  const source = {
    overrides: [{ param_key: 'level.min', phase_key: '', value: '55' }],
    defaults: [
      { key: 'level.min', default_value: '20' },
      { key: 'level.max', default_value: '90' },
    ],
    currentPhase: {
      key: 'commissioning',
      name: 'Commissioning',
      context_notes: 'readings may be unstable',
      targets: [{ param_key: 'level.min', value: '40' }],
    },
  };

  it('maps each layer onto the shape the resolver expects', () => {
    const ctx = buildParamContext(source);
    expect(ctx.overrides).toEqual({ 'level.min': '55' });
    expect(ctx.phaseOverrides).toEqual({});
    expect(ctx.phaseTargets).toEqual({ 'level.min': '40' });
    expect(ctx.defaults).toEqual({ 'level.min': '20', 'level.max': '90' });
    expect(ctx.phase).toEqual({
      key: 'commissioning',
      name: 'Commissioning',
      context_notes: 'readings may be unstable',
    });
  });

  it('produces a context the resolver reads with the documented precedence', () => {
    const ctx = buildParamContext(source);
    expect(resolveParam('@phase.level.min', ctx)).toBe('55'); // override wins
    expect(resolveParam('@phase.level.max', ctx)).toBe('90'); // no target ⇒ default
  });

  it('yields no phase and no targets for an instance between phases', () => {
    const ctx = buildParamContext({ ...source, currentPhase: null });
    expect(ctx.phase).toBeNull();
    expect(ctx.phaseTargets).toEqual({});
    expect(resolveParam('@phase.name', ctx)).toBeNull();
  });

  it('normalises absent phase notes to null rather than undefined', () => {
    const ctx = buildParamContext({
      ...source,
      currentPhase: { key: 'steady', name: 'Steady', targets: [] },
    });
    expect(ctx.phase).toEqual({ key: 'steady', name: 'Steady', context_notes: null });
  });

  it('resolves every reference to null in the empty context, so a non-blueprint entity fails closed', () => {
    expect(resolveParam('@phase.level.min', EMPTY_PARAM_CONTEXT)).toBeNull();
    expect(resolveParam('@param.anything', EMPTY_PARAM_CONTEXT)).toBeNull();
    expect(resolveParam('42', EMPTY_PARAM_CONTEXT)).toBe('42');
  });
});

// Per-phase user overrides. The point of the scope is that "correct this one phase" and "ignore the
// schedule entirely" stopped being the same act — so the tests that matter are the ones showing a
// value applying in one phase and *not* in the others.
describe('parameter references — per-phase overrides', () => {
  const defaults = [{ key: 'level.min', default_value: '20' }];
  const seedling = {
    key: 'seedling',
    name: 'Seedling',
    targets: [{ param_key: 'level.min', value: '40' }],
  };
  const mature = {
    key: 'mature',
    name: 'Mature',
    targets: [{ param_key: 'level.min', value: '60' }],
  };

  const ctxFor = (
    overrides: { param_key: string; phase_key: string; value: string }[],
    phase: typeof seedling | null,
  ) => buildParamContext({ overrides, defaults, currentPhase: phase });

  it('applies a phase-scoped override only while the instance is in that phase', () => {
    const overrides = [{ param_key: 'level.min', phase_key: 'mature', value: '75' }];
    expect(resolveParam('@phase.level.min', ctxFor(overrides, mature))).toBe('75');
    // Seedling is untouched by it and stays on the blueprint's own schedule.
    expect(resolveParam('@phase.level.min', ctxFor(overrides, seedling))).toBe('40');
  });

  it('lets the more specific phase row beat the user’s all-phases row', () => {
    const overrides = [
      { param_key: 'level.min', phase_key: '', value: '55' },
      { param_key: 'level.min', phase_key: 'mature', value: '75' },
    ];
    expect(resolveParam('@phase.level.min', ctxFor(overrides, mature))).toBe('75');
    expect(resolveParam('@phase.level.min', ctxFor(overrides, seedling))).toBe('55');
  });

  it('keeps a phase-scoped row out of @param., which addresses the blueprint value', () => {
    const overrides = [{ param_key: 'level.min', phase_key: 'mature', value: '75' }];
    expect(resolveParam('@param.level.min', ctxFor(overrides, mature))).toBe('20');
  });

  it('ignores a row scoped to a phase the instance is not in, including when it has none', () => {
    const overrides = [{ param_key: 'level.min', phase_key: 'mature', value: '75' }];
    const ctx = ctxFor(overrides, null);
    expect(ctx.phaseOverrides).toEqual({});
    expect(resolveParam('@phase.level.min', ctx)).toBe('20');
  });

  it('reports the layer it used, so the instance page cannot mislabel a value', () => {
    const overrides = [
      { param_key: 'level.min', phase_key: '', value: '55' },
      { param_key: 'level.min', phase_key: 'mature', value: '75' },
    ];
    expect(resolveParamWithSource('level.min', ctxFor(overrides, mature))).toEqual({
      value: '75',
      source: 'phase_override',
    });
    expect(resolveParamWithSource('level.min', ctxFor(overrides, seedling))).toEqual({
      value: '55',
      source: 'override',
    });
    expect(resolveParamWithSource('level.min', ctxFor([], seedling))).toEqual({
      value: '40',
      source: 'phase',
    });
    expect(resolveParamWithSource('level.min', ctxFor([], null))).toEqual({
      value: '20',
      source: 'default',
    });
  });
});

// ── Per-device layers and the dynamic form (F11.3 / F11.6) ──────────────────────────────────
//
// One setup can hold several devices on independent schedules, so a value may now be tuned for ONE
// of them. That adds two layers on top of the four, and they must sit *above* the setup-wide ones:
// "this device wants something different" is more specific than "this setup does".
//
// Fields are the other half. They are facts the user states, not values the system tunes, so they
// deliberately do NOT walk the layers — the only order is device answer → setup answer → default.

describe('per-device overrides (F11.3)', () => {
  const perDeviceDefaults = [{ key: 'level.min', default_value: '20' }];
  const growPhase = {
    key: 'grow',
    name: 'Grow',
    targets: [{ param_key: 'level.min', value: '40' }],
  };
  interface Override {
    param_key: string;
    phase_key: string;
    value: string;
  }

  const ctxFor = (setup: Override[], binding: Override[] | null): ParamContext =>
    buildParamContext({
      overrides: setup,
      defaults: perDeviceDefaults,
      currentPhase: growPhase,
      binding: binding ? { overrides: binding, lifecycle: 'running' } : null,
    });

  const setupBoth: Override[] = [
    { param_key: 'level.min', phase_key: '', value: '50' },
    { param_key: 'level.min', phase_key: 'grow', value: '55' },
  ];

  it("lets one device's own override beat the setup-wide one", () => {
    const ctx = ctxFor(
      [{ param_key: 'level.min', phase_key: '', value: '55' }],
      [{ param_key: 'level.min', phase_key: '', value: '65' }],
    );
    expect(resolveParamWithSource('level.min', ctx)).toEqual({
      value: '65',
      source: 'binding_override',
    });
  });

  it("lets a device's phase-scoped override beat its own all-phases one", () => {
    const ctx = ctxFor(
      [],
      [
        { param_key: 'level.min', phase_key: '', value: '65' },
        { param_key: 'level.min', phase_key: 'grow', value: '75' },
      ],
    );
    expect(resolveParamWithSource('level.min', ctx)).toEqual({
      value: '75',
      source: 'binding_phase_override',
    });
  });

  it("keeps a device's phase-scoped override out of @param.", () => {
    // `@param.` addresses the blueprint's own value for the settings a phase may not retune, and
    // that rule has to hold one level down too — otherwise the per-device layer would be a way to
    // smuggle a phase-scoped value into a reference that is defined as phase-free.
    const ctx = ctxFor([], [{ param_key: 'level.min', phase_key: 'grow', value: '75' }]);
    expect(resolveParam('@param.level.min', ctx)).toBe('20');
    expect(resolveParam('@phase.level.min', ctx)).toBe('75');
  });

  it('resolves through all six layers in order, most specific first', () => {
    // Peel one layer off at a time; each assertion pins which layer takes over next.
    expect(
      resolveParamWithSource(
        'level.min',
        ctxFor(setupBoth, [
          { param_key: 'level.min', phase_key: '', value: '60' },
          { param_key: 'level.min', phase_key: 'grow', value: '65' },
        ]),
      ),
    ).toEqual({ value: '65', source: 'binding_phase_override' });

    expect(
      resolveParamWithSource(
        'level.min',
        ctxFor(setupBoth, [{ param_key: 'level.min', phase_key: '', value: '60' }]),
      ),
    ).toEqual({ value: '60', source: 'binding_override' });

    expect(resolveParamWithSource('level.min', ctxFor(setupBoth, []))).toEqual({
      value: '55',
      source: 'phase_override',
    });

    expect(
      resolveParamWithSource(
        'level.min',
        ctxFor([{ param_key: 'level.min', phase_key: '', value: '50' }], []),
      ),
    ).toEqual({ value: '50', source: 'override' });

    expect(resolveParamWithSource('level.min', ctxFor([], []))).toEqual({
      value: '40',
      source: 'phase',
    });
  });

  it('leaves a setup with no per-device context on exactly the four layers it always had', () => {
    // The regression guard for every pre-F11 setup: absent binding layers, not empty ones.
    const ctx = ctxFor([], null);
    expect(ctx.bindingOverrides).toBeUndefined();
    expect(ctx.bindingPhaseOverrides).toBeUndefined();
    expect(resolveParamWithSource('level.min', ctx)).toEqual({ value: '40', source: 'phase' });
  });
});

describe('field references (F11.6)', () => {
  const ctxFor = (fields: Parameters<typeof buildParamContext>[0]['fields']): ParamContext =>
    buildParamContext({ overrides: [], defaults: [], currentPhase: null, fields });

  it('resolves a field to the answer given for this device', () => {
    const ctx = ctxFor({
      binding: [{ field_key: 'variant', value: 'B' }],
      instance: [{ field_key: 'variant', value: 'A' }],
      defaults: [{ key: 'variant', default_value: 'unset' }],
    });
    expect(resolveParam('@field.variant', ctx)).toBe('B');
  });

  it('falls back to the setup answer when the device was not asked', () => {
    const ctx = ctxFor({
      binding: [],
      instance: [{ field_key: 'variant', value: 'A' }],
      defaults: [{ key: 'variant', default_value: 'unset' }],
    });
    expect(resolveParam('@field.variant', ctx)).toBe('A');
  });

  it("falls back to the field's default when neither was answered", () => {
    const ctx = ctxFor({ defaults: [{ key: 'variant', default_value: 'unset' }] });
    expect(resolveParam('@field.variant', ctx)).toBe('unset');
  });

  it('resolves an unanswered field to null so the caller fails closed', () => {
    // A declared field with no answer and no default must not resolve to "" — an empty string is a
    // value, and a threshold or prompt built from one would look answered when it is not.
    const ctx = ctxFor({ defaults: [{ key: 'variant', default_value: null }] });
    expect(resolveParam('@field.variant', ctx)).toBeNull();
    expect(resolveParam('@field.variant', EMPTY_PARAM_CONTEXT)).toBeNull();
  });

  it('rejects a reference to an undeclared field and names it', () => {
    expect(validateParamRefs('@field.typo', ['level.min'], ['variant'])).toEqual([
      '@field.typo references an undeclared field "typo"',
    ]);
  });

  it('accepts a reference to a declared field', () => {
    expect(validateParamRefs('@field.variant', [], ['variant'])).toEqual([]);
  });

  it('substitutes a field reference inside a prompt template', () => {
    const ctx = ctxFor({ binding: [{ field_key: 'variant', value: 'B' }] });
    expect(resolveText('This one is running @field.variant.', ctx)).toEqual({
      text: 'This one is running B.',
      unresolved: [],
    });
  });
});
