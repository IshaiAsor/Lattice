// Pure unit test (no stack required) for the sim's per-type command validation, which mirrors the
// firmware command classes' BaseCommandAction::validateActionPayload.

const { validate } = require('../../tools/device-sim/lib/command-models');

describe('command-models validate()', () => {
  test('OutletCommandAction accepts on/off/1/0 and rejects others', () => {
    for (const v of ['on', 'off', '1', '0']) expect(validate('OutletCommandAction', v)).toBe(true);
    for (const v of ['banana', '50', 'ON']) expect(validate('OutletCommandAction', v)).toBe(false);
  });

  test('LightDimmerAction accepts on/off and 0..100, rejects out-of-range / non-numeric', () => {
    for (const v of ['on', 'off', 0, 50, 100, '0', '100'])
      expect(validate('LightDimmerAction', v)).toBe(true);
    for (const v of [101, -1, 'bright', '12.5'])
      expect(validate('LightDimmerAction', v)).toBe(false);
  });

  test('OneDirectionalMotorAction behaves like the dimmer range', () => {
    expect(validate('OneDirectionalMotorAction', 75)).toBe(true);
    expect(validate('OneDirectionalMotorAction', 200)).toBe(false);
  });

  test('PwmOutputAction behaves like the dimmer range', () => {
    for (const v of ['on', 'off', 0, 50, 100]) expect(validate('PwmOutputAction', v)).toBe(true);
    for (const v of [101, -1, 'duty']) expect(validate('PwmOutputAction', v)).toBe(false);
  });

  test('I2cSocket8Action / I2cSocket16Action behave like the outlet (on/off/1/0)', () => {
    for (const impl of ['I2cSocket8Action', 'I2cSocket16Action']) {
      for (const v of ['on', 'off', '1', '0']) expect(validate(impl, v)).toBe(true);
      for (const v of ['banana', '50', 'ON']) expect(validate(impl, v)).toBe(false);
    }
  });

  test('unknown implementation types are accepted optimistically', () => {
    expect(validate('SomeFutureAction', 'whatever')).toBe(true);
    expect(validate(undefined, 'whatever')).toBe(true);
  });
});
