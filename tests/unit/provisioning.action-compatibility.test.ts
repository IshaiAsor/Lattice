// Unit: OTA action-migration compatibility + pin mapping
// (device-gateway/src/services/action-compatibility.ts).

import {
  isCompatible,
  migratePins,
} from '../../services/device-gateway/src/services/action-compatibility';

describe('isCompatible', () => {
  const cap = (impl: string, keys: string[]) => ({
    implementation_type: impl,
    pins: keys.map((key) => ({ key })),
  });
  const pins = (keys: string[]) => keys.map((key) => ({ key }));

  it('accepts identical implementation type and pin slots', () => {
    expect(
      isCompatible('OutletCommandAction', pins(['power']), cap('OutletCommandAction', ['power'])),
    ).toEqual({ compatible: true });
  });

  it('rejects a changed implementation type', () => {
    const r = isCompatible(
      'OutletCommandAction',
      pins(['power']),
      cap('DimmerCommandAction', ['power']),
    );
    expect(r.compatible).toBe(false);
    expect(r.reason).toBe('implementation type changed');
  });

  it('rejects a changed pin count', () => {
    const r = isCompatible('SensorAction', pins(['data']), cap('SensorAction', ['data', 'clock']));
    expect(r.compatible).toBe(false);
    expect(r.reason).toBe('pin count changed');
  });

  it('rejects a renamed pin slot and names it in the reason', () => {
    const r = isCompatible('SensorAction', pins(['data']), cap('SensorAction', ['signal']));
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain('"data" renamed to "signal"');
  });

  it('accepts zero-pin capabilities', () => {
    expect(isCompatible('VirtualAction', [], cap('VirtualAction', []))).toEqual({
      compatible: true,
    });
  });
});

describe('migratePins', () => {
  const oldCatalog = [
    { id: 1, key: 'data' },
    { id: 2, key: 'clock' },
  ];
  const newCatalog = [
    { id: 11, key: 'data' },
    { id: 12, key: 'clock' },
  ];

  it('remaps configured pins to the new capability pin ids by key', () => {
    const result = migratePins(oldCatalog, newCatalog, [
      { capability_pin_id: 1, pin_number: 4 },
      { capability_pin_id: 2, pin_number: 5 },
    ]);
    expect(result).toEqual([
      { capability_pin_id: 11, pin_number: 4 },
      { capability_pin_id: 12, pin_number: 5 },
    ]);
  });

  it('drops pins whose key no longer exists in the new capability', () => {
    const result = migratePins(
      oldCatalog,
      [{ id: 11, key: 'data' }],
      [
        { capability_pin_id: 1, pin_number: 4 },
        { capability_pin_id: 2, pin_number: 5 },
      ],
    );
    expect(result).toEqual([{ capability_pin_id: 11, pin_number: 4 }]);
  });

  it('drops pins referencing unknown old catalog ids', () => {
    const result = migratePins(oldCatalog, newCatalog, [{ capability_pin_id: 99, pin_number: 4 }]);
    expect(result).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect(migratePins([], [], [])).toEqual([]);
  });
});
