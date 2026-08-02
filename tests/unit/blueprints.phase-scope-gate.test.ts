// Blueprints (F10 follow-up): the phase-scope gate in `@lattice/params`.
//
// A blueprint automation (rule / scene / pipeline) may declare the phases it is active in. This
// one predicate decides whether it is live in the instance's current phase, and it is shared by
// automation-worker (rules), digest-service (pipeline triggers) and api (scene execution) — three
// callers that must agree, so the truth table is pinned here rather than in each service.

import { isAutomationLive, isInstanceRunning, isPhaseInScope } from '../../packages/params/src';

describe('isPhaseInScope (phase gate)', () => {
  describe('empty scope = active in every phase', () => {
    it('is active in any phase', () => {
      expect(isPhaseInScope([], 'commissioning')).toBe(true);
    });
    it('is active even with no current phase', () => {
      expect(isPhaseInScope([], null)).toBe(true);
    });
    it('treats null/undefined scope like an empty one (defensive)', () => {
      expect(isPhaseInScope(null, 'anything')).toBe(true);
      expect(isPhaseInScope(undefined, null)).toBe(true);
    });
  });

  describe('non-empty scope = active only in a listed phase', () => {
    it('is active when the current phase is in scope', () => {
      expect(isPhaseInScope(['commissioning'], 'commissioning')).toBe(true);
    });
    it('is inactive when the current phase is not in scope', () => {
      expect(isPhaseInScope(['commissioning'], 'steady')).toBe(false);
    });
    it('matches any one of several scoped phases', () => {
      expect(isPhaseInScope(['germination', 'fruiting'], 'fruiting')).toBe(true);
      expect(isPhaseInScope(['germination', 'fruiting'], 'harvest')).toBe(false);
    });
    it('is inactive when the instance has no current phase — it cannot be "in" an unset phase', () => {
      expect(isPhaseInScope(['commissioning'], null)).toBe(false);
      expect(isPhaseInScope(['commissioning'], undefined)).toBe(false);
    });
  });
});

// ── The lifecycle gate (F10.13) ─────────────────────────────────────────────────────────────
//
// Coarser than phase scope and sits in front of it: a setup the user has not started, or has
// stopped, does *nothing*. The same three callers apply it, so the truth table is pinned here too
// — an automation that fires in one path and is held in another is the bug this prevents.

describe('isInstanceRunning (lifecycle gate)', () => {
  it('is running only in the running state', () => {
    expect(isInstanceRunning('running')).toBe(true);
    expect(isInstanceRunning('stopped')).toBe(false);
    expect(isInstanceRunning('not_started')).toBe(false);
  });

  it('treats "no instance" as live — a hand-written rule is not gated by blueprints at all', () => {
    expect(isInstanceRunning(null)).toBe(true);
    expect(isInstanceRunning(undefined)).toBe(true);
  });

  it('refuses an unrecognised state rather than assuming it means running', () => {
    // A state this build does not know about is not a licence to act.
    expect(isInstanceRunning('paused_by_something_newer')).toBe(false);
  });
});

describe('isAutomationLive (both gates)', () => {
  it('needs the setup running AND the phase in scope', () => {
    expect(isAutomationLive(['steady'], 'steady', 'running')).toBe(true);
    expect(isAutomationLive(['steady'], 'commissioning', 'running')).toBe(false);
  });

  it('holds an unscoped automation too — stopping a setup stops all of it', () => {
    // The load-bearing case: empty scope passes the phase gate, and must still be held.
    expect(isAutomationLive([], 'steady', 'running')).toBe(true);
    expect(isAutomationLive([], 'steady', 'stopped')).toBe(false);
    expect(isAutomationLive([], null, 'not_started')).toBe(false);
  });

  it('leaves hand-written automations untouched', () => {
    expect(isAutomationLive([], null, null)).toBe(true);
  });

  it('holds a scoped automation whose setup is stopped in one of its phases', () => {
    // Both gates matter independently: being in scope is not enough.
    expect(isAutomationLive(['steady'], 'steady', 'stopped')).toBe(false);
  });
});
