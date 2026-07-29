// Blueprints (F10.1): the `@param.` / `@phase.` reference grammar in `@lattice/params`.
//
// This is the contract three services depend on — automation-worker resolves thresholds,
// api validates on write, ml-router resolves sensor bounds and prompt text. The precedence
// (override → phase → default) is what lets reconcile, phase advance and user tuning coexist,
// so it is pinned here rather than left to each caller.

import {
  ParamContext,
  EMPTY_PARAM_CONTEXT,
  buildParamContext,
  findParamRefs,
  isParamRef,
  parseParamRef,
  resolveParam,
  resolveText,
  validateParamKey,
  validateParamRefs,
} from '../../packages/params/src';

const ctx = (over: Partial<ParamContext> = {}): ParamContext => ({
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
    overrides: [{ param_key: 'level.min', value: '55' }],
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
