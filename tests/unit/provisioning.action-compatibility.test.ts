// Unit: OTA action-migration compatibility + pin mapping
// (device-gateway/src/services/action-compatibility.ts).

import {
  isCompatible,
  migratePins,
  indexCapabilitiesByKey,
  diffSealedTemplate,
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

// F3.18: a sealed device's update preview must describe stageSealedUpgrade, not the generic
// capability diff. Observed on staging 2026-08-09: all 8 channels of MULTI_SOCKET_8_CH were
// flagged "implementation type changed" under a deprecation warning, so the dialog read as
// "this will destroy your device" — while applyUpdate would have staged the template cleanly and
// deprecated nothing.
describe('diffSealedTemplate', () => {
  const entry = (name: string, key = `cap.${name}`, sort = 0) => ({
    capability_key: key,
    mqtt_action_name: name,
    action_label: `Label ${name}`,
    sort_order: sort,
  });
  const action = (id: number, name: string, label = `User ${name}`) => ({
    id,
    action_name: label,
    mqtt_action_name: name,
  });
  const keys = (...k: string[]) => new Set(k);

  it('carries every channel across as ok — the exact case that used to read as destroyed', () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(`socket_${i + 1}`, `cap.socket`, i));
    const existing = entries.map((e, i) => action(i + 1, e.mqtt_action_name));

    const out = diffSealedTemplate(entries, existing, keys('cap.socket'));

    expect(out).toHaveLength(8);
    expect(out.every((a) => a.status === 'ok')).toBe(true);
    expect(out.some((a) => a.reason)).toBe(false);
  });

  it('keeps the user-facing name of a carried action rather than resetting it to the template label', () => {
    const out = diffSealedTemplate(
      [entry('pump')],
      [action(7, 'pump', 'Greenhouse pump')],
      keys('cap.pump'),
    );
    expect(out).toEqual([{ id: 7, name: 'Greenhouse pump', mqttName: 'pump', status: 'ok' }]);
  });

  it('marks an entry with no existing action as new, with no row id', () => {
    const out = diffSealedTemplate([entry('fan')], [], keys('cap.fan'));
    expect(out).toEqual([
      {
        id: null,
        name: 'Label fan',
        mqttName: 'fan',
        status: 'new',
        reason: 'added in this version',
      },
    ]);
  });

  it('deprecates only an action the new template actually drops', () => {
    const out = diffSealedTemplate(
      [entry('pump')],
      [action(1, 'pump'), action(2, 'legacy_valve')],
      keys('cap.pump'),
    );
    expect(out.find((a) => a.mqttName === 'pump')!.status).toBe('ok');
    const gone = out.find((a) => a.mqttName === 'legacy_valve')!;
    expect(gone.status).toBe('deprecated');
    expect(gone.id).toBe(2);
  });

  // Mirrors stageSealedUpgrade's `if (!cap) continue` — an entry the target version cannot
  // materialize is skipped there, so promising it here would describe an action that never appears.
  it('skips an entry whose capability the target version does not carry', () => {
    const out = diffSealedTemplate(
      [entry('pump'), entry('camera', 'cap.camera')],
      [action(1, 'pump')],
      keys('cap.pump'),
    );
    expect(out.map((a) => a.mqttName)).toEqual(['pump']);
  });

  it('orders staged entries by sort_order', () => {
    const out = diffSealedTemplate(
      [entry('c', 'cap.c', 2), entry('a', 'cap.a', 0), entry('b', 'cap.b', 1)],
      [],
      keys('cap.a', 'cap.b', 'cap.c'),
    );
    expect(out.map((a) => a.mqttName)).toEqual(['a', 'b', 'c']);
  });

  // confirmOtaIfPending picks the survivor with `orderBy: { id: 'asc' }`; the preview must name
  // the same row, or it reports a rename that will not happen.
  it('matches the lowest-id row when a name is duplicated, as the confirm path does', () => {
    const out = diffSealedTemplate(
      [entry('pump')],
      [action(9, 'pump', 'Second'), action(3, 'pump', 'First')],
      keys('cap.pump'),
    );
    expect(out[0]).toMatchObject({ id: 3, name: 'First', status: 'ok' });
  });
});
