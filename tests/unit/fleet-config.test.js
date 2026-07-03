// Pure unit test (no stack required) for the device-sim fleet config merge/MAC-generation logic.

const { compact, loadFleetConfig, checkMacCollisions } = require('../../tools/device-sim/lib/fleet-config');

describe('compact()', () => {
  test('drops undefined-valued keys, keeps everything else', () => {
    expect(compact({ a: 1, b: undefined, c: false, d: 0, e: '' })).toEqual({ a: 1, c: false, d: 0, e: '' });
  });
});

describe('loadFleetConfig()', () => {
  test('rejects a missing/empty devices array', () => {
    expect(() => loadFleetConfig({}, {})).toThrow(/devices/);
    expect(() => loadFleetConfig({ devices: [] }, {})).toThrow(/devices/);
  });

  test('rejects a device group missing "type"', () => {
    expect(() => loadFleetConfig({ devices: [{ count: 2 }] }, {})).toThrow(/type/);
  });

  test('rejects a non-positive count', () => {
    expect(() => loadFleetConfig({ devices: [{ type: 'ESP32S3_MINI', count: 0 }] }, {})).toThrow(/count/);
    expect(() => loadFleetConfig({ devices: [{ type: 'ESP32S3_MINI', count: -1 }] }, {})).toThrow(/count/);
  });

  test('rejects defaults.mac', () => {
    expect(() => loadFleetConfig({ defaults: { mac: 'X' }, devices: [{ type: 'ESP32S3_MINI' }] }, {})).toThrow(/defaults\.mac/);
  });

  test('defaults to count 1 and auto-generates a MAC', () => {
    const instances = loadFleetConfig({ devices: [{ type: 'ESP32S3_MINI' }] }, {});
    expect(instances).toHaveLength(1);
    expect(instances[0].opts.mac).toBe('SIM-ESP32S3_MINI-01');
    expect(instances[0].opts.deviceType).toBe('ESP32S3_MINI');
    expect(instances[0].label).toBe('MINI#01');
  });

  test('numbers auto-generated MACs/labels across multiple groups of the same type (no collision)', () => {
    const config = {
      devices: [
        { type: 'ESP32S3_MINI', count: 2 },
        { type: 'ESP32S3_CAM', count: 1 },
        { type: 'ESP32S3_MINI', count: 2 },
      ],
    };
    const instances = loadFleetConfig(config, {});
    const minis = instances.filter((i) => i.opts.deviceType === 'ESP32S3_MINI');
    expect(minis.map((i) => i.opts.mac)).toEqual([
      'SIM-ESP32S3_MINI-01', 'SIM-ESP32S3_MINI-02', 'SIM-ESP32S3_MINI-03', 'SIM-ESP32S3_MINI-04',
    ]);
    expect(minis.map((i) => i.label)).toEqual(['MINI#01', 'MINI#02', 'MINI#03', 'MINI#04']);
    expect(new Set(instances.map((i) => i.opts.mac)).size).toBe(instances.length);
  });

  test('explicit mac on a count:1 group is used literally', () => {
    const instances = loadFleetConfig({ devices: [{ type: 'ESP32S3_MINI', mac: 'SIM-CUSTOM' }] }, {});
    expect(instances[0].opts.mac).toBe('SIM-CUSTOM');
  });

  test('explicit mac on a count>1 group is used as a prefix', () => {
    const instances = loadFleetConfig({ devices: [{ type: 'ESP32S3_MINI', mac: 'SIM-CUSTOM', count: 2 }] }, {});
    expect(instances.map((i) => i.opts.mac)).toEqual(['SIM-CUSTOM-01', 'SIM-CUSTOM-02']);
  });

  test('rejects duplicate MACs across groups', () => {
    const config = {
      devices: [
        { type: 'ESP32S3_MINI', mac: 'SIM-DUP', count: 1 },
        { type: 'ESP32S3_CAM', mac: 'SIM-DUP', count: 1 },
      ],
    };
    expect(() => loadFleetConfig(config, {})).toThrow(/duplicate mac/);
  });

  test('passes "capabilities" through as a per-group override', () => {
    const instances = loadFleetConfig({ devices: [{ type: 'ESP32S3_MINI', capabilities: ['outlet', 'temperature'] }] }, {});
    expect(instances[0].opts.capabilities).toEqual(['outlet', 'temperature']);
  });

  test('rejects a non-array/non-string "capabilities"', () => {
    expect(() => loadFleetConfig({ devices: [{ type: 'ESP32S3_MINI', capabilities: 'outlet' }] }, {})).toThrow(/capabilities/);
    expect(() => loadFleetConfig({ devices: [{ type: 'ESP32S3_MINI', capabilities: [1, 2] }] }, {})).toThrow(/capabilities/);
  });

  test('merges opts: baseOpts < config.defaults < group overrides, deviceType/mac always win', () => {
    const baseOpts = { apiUrl: 'http://base', telemetryMs: 1000, activateAll: false };
    const config = {
      defaults: { telemetryMs: 2000, activateAll: true },
      devices: [{ type: 'ESP32S3_CAM', telemetryMs: 3000, camera: true }],
    };
    const instances = loadFleetConfig(config, baseOpts);
    expect(instances[0].opts).toMatchObject({
      apiUrl: 'http://base', // from baseOpts, untouched by config
      activateAll: true,     // config.defaults overrides baseOpts
      telemetryMs: 3000,     // group override wins over config.defaults
      camera: true,          // group-only override
      deviceType: 'ESP32S3_CAM',
    });
  });

  test('undefined-valued keys in baseOpts do not clobber config values (compact applied)', () => {
    const baseOpts = { telemetryMs: undefined, apiUrl: 'http://base' };
    const config = { devices: [{ type: 'ESP32S3_MINI' }] };
    const instances = loadFleetConfig(config, baseOpts);
    expect(instances[0].opts.telemetryMs).toBeUndefined();
    expect('telemetryMs' in instances[0].opts).toBe(false);
    expect(instances[0].opts.apiUrl).toBe('http://base');
  });
});

describe('checkMacCollisions()', () => {
  test('passes for unique macs, throws for duplicates', () => {
    expect(() => checkMacCollisions([{ opts: { mac: 'a', deviceType: 'X' } }, { opts: { mac: 'b', deviceType: 'Y' } }])).not.toThrow();
    expect(() => checkMacCollisions([{ opts: { mac: 'a', deviceType: 'X' } }, { opts: { mac: 'a', deviceType: 'Y' } }])).toThrow(/duplicate mac/);
  });
});
