// Blueprints (F10 follow-up): the phase-scope gate in `@lattice/params`.
//
// A blueprint automation (rule / scene / pipeline) may declare the phases it is active in. This
// one predicate decides whether it is live in the instance's current phase, and it is shared by
// automation-worker (rules), digest-service (pipeline triggers) and api (scene execution) — three
// callers that must agree, so the truth table is pinned here rather than in each service.

import { isPhaseInScope } from '../../packages/params/src';

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
