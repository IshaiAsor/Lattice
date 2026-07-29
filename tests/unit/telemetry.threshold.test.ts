// Unit: pipeline sensor-threshold evaluation (@lattice/params — shared by automation-worker's
// trigger matcher and digest-service's fault guard).

import { evaluateThreshold, isErrorReading, isTriggerInCooldown } from '@lattice/params';

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

  it('never satisfies a threshold for a fault reading', () => {
    // A fault envelope must not fire a value trigger, whatever the operator/threshold.
    const fault = { error: 'read_failed', action: 'temperature' };
    expect(evaluateThreshold(fault, '>', '20')).toBe(false);
    expect(evaluateThreshold(fault, '<', '20')).toBe(false);
    expect(evaluateThreshold(fault, '=', '[object Object]')).toBe(false);
  });
});

describe('isErrorReading', () => {
  it('recognizes a fault envelope', () => {
    expect(isErrorReading({ error: 'read_failed', action: 'temperature' })).toBe(true);
    expect(isErrorReading({ error: 'anything' })).toBe(true);
  });

  it('rejects normal scalar/object readings', () => {
    expect(isErrorReading(23.5)).toBe(false);
    expect(isErrorReading('23.5')).toBe(false);
    expect(isErrorReading('on')).toBe(false);
    expect(isErrorReading(null)).toBe(false);
    expect(isErrorReading({ value: 'on' })).toBe(false);
    expect(isErrorReading({ error: 42 })).toBe(false); // error must be a string
  });
});

describe('isTriggerInCooldown', () => {
  const now = new Date('2026-07-28T10:00:30Z');

  it('is not in cooldown when the trigger has never fired', () => {
    expect(isTriggerInCooldown(null, 30, now)).toBe(false);
    expect(isTriggerInCooldown(undefined, 30, now)).toBe(false);
  });

  it('is not in cooldown when no interval is set', () => {
    expect(isTriggerInCooldown(new Date('2026-07-28T10:00:29Z'), null, now)).toBe(false);
    expect(isTriggerInCooldown(new Date('2026-07-28T10:00:29Z'), 0, now)).toBe(false);
  });

  it('is in cooldown while inside the interval window', () => {
    // fired 10s ago, 30s interval → still cooling down
    expect(isTriggerInCooldown(new Date('2026-07-28T10:00:20Z'), 30, now)).toBe(true);
  });

  it('is out of cooldown once the interval has elapsed', () => {
    // fired 30s ago, 30s interval → boundary is not "less than", so it may fire
    expect(isTriggerInCooldown(new Date('2026-07-28T10:00:00Z'), 30, now)).toBe(false);
    // fired 40s ago → well clear
    expect(isTriggerInCooldown(new Date('2026-07-28T09:59:50Z'), 30, now)).toBe(false);
  });
});
