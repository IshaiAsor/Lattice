// Unit: pipeline sensor-threshold evaluation (digest-service/src/threshold.ts).

import { evaluateThreshold } from '../../services/digest-service/src/threshold';

describe('evaluateThreshold', () => {
  it.each([
    [25, '>', '20', true],
    [15, '>', '20', false],
    [15, '<', '20', true],
    [25, '<', '20', false],
    [20, '>=', '20', true],
    [19.9, '>=', '20', false],
    [20, '<=', '20', true],
    [20.1, '<=', '20', false],
    [20, '=', '20', true],
    [20, '==', '20', true],
    [21, '=', '20', false],
  ])('%s %s %s → %s', (value, op, threshold, expected) => {
    expect(evaluateThreshold(value, op, threshold)).toBe(expected);
  });

  it('parses numeric strings', () => {
    expect(evaluateThreshold('23.5', '>', '20')).toBe(true);
    expect(evaluateThreshold('19', '>', '20')).toBe(false);
  });

  it('falls back to string equality when either side is not numeric', () => {
    expect(evaluateThreshold('on', '=', 'on')).toBe(true);
    expect(evaluateThreshold('off', '=', 'on')).toBe(false);
    // Non-numeric value with a non-equality operator still uses string equality fallback.
    expect(evaluateThreshold('on', '>', 'on')).toBe(true);
  });

  it('returns false for unknown operators on numeric input', () => {
    expect(evaluateThreshold(25, '!=', '20')).toBe(false);
    expect(evaluateThreshold(25, '', '20')).toBe(false);
  });
});
