// Unit: OTA action-migration compatibility + pin mapping
// (device-gateway/src/services/action-compatibility.ts).

import {
  isCompatible,
  migratePins,
  indexCapabilitiesByKey,
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

  // The catalog rows these arrays come from are loaded with no ORDER BY, so two identical
  // capabilities can legitimately arrive in different orders. Comparing positionally reported a
  // rename that never happened.
  it('accepts the same pin slots in a different order', () => {
    expect(
      isCompatible(
        'I2cSocket8Action',
        pins(['sda', 'scl', 'address', 'channel']),
        cap('I2cSocket8Action', ['address', 'channel', 'scl', 'sda']),
      ),
    ).toEqual({ compatible: true });
  });

  it('names every pin slot that disappeared when several do', () => {
    const r = isCompatible(
      'SensorAction',
      pins(['data', 'clock']),
      cap('SensorAction', ['signal', 'strobe']),
    );
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain('"data"');
    expect(r.reason).toContain('"clock"');
  });
});

describe('indexCapabilitiesByKey', () => {
  // mqtt_action_name is not unique within a device row: the 8- and 16-channel I2C socket
  // capabilities both publish as "socket". Indexing on it kept only the last one, so every
  // channel of an 8-channel board was compared against the 16-channel capability and reported
  // as "implementation type changed" on an upgrade that changed nothing about it.
  const socket8 = {
    capability_key: 'i2c_socket_8',
    mqtt_action_name: 'socket',
    implementation_type: 'I2cSocket8Action',
  };
  const socket16 = {
    capability_key: 'i2c_socket_16',
    mqtt_action_name: 'socket',
    implementation_type: 'I2cSocket16Action',
  };

  it('keeps capabilities that share an mqtt_action_name', () => {
    const index = indexCapabilitiesByKey([socket8, socket16]);
    expect(index.size).toBe(2);
    expect(index.get('i2c_socket_8')).toBe(socket8);
    expect(index.get('i2c_socket_16')).toBe(socket16);
  });

  it('resolves an action to its own capability, not a same-named sibling', () => {
    const index = indexCapabilitiesByKey([socket8, socket16]);
    const counterpart = index.get('i2c_socket_8');
    expect(isCompatible('I2cSocket8Action', [], { ...counterpart!, pins: [] })).toEqual({
      compatible: true,
    });
  });

  it('reports a genuinely removed capability as absent', () => {
    expect(indexCapabilitiesByKey([socket16]).get('i2c_socket_8')).toBeUndefined();
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
