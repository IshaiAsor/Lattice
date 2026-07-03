'use strict';
// Pure config-merging logic for the fleet CLI mode (see ../index.js). No I/O — takes an
// already-parsed config object and the env-derived base opts, returns the list of SimDevice
// constructor opts to instantiate. Kept separate from index.js so it's unit-testable without a
// running stack, mirroring how command-models.js is split out from sim-device.js.
//
//   const { loadFleetConfig } = require('./lib/fleet-config');
//   const instances = loadFleetConfig(JSON.parse(fs.readFileSync('fleet.json')), baseOpts);
//   // -> [{ label: 'MINI#01', opts: { deviceType, mac, ...merged } }, ...]

// Object spread copies own-enumerable keys even when the value is `undefined`, which silently
// overwrites downstream defaults (e.g. SimDevice's `{ ...DEFAULTS, ...opts }`). Strip those keys
// so "unset" means "absent", not "present with an undefined value".
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

// type -> label used in per-device log prefixes, e.g. ESP32S3_CAM -> CAM.
function shortLabel(type) {
  return String(type).replace(/^ESP32S3_/, '') || type;
}

// Validates + flattens `config.devices` (grouped by type/count) into one ordered per-instance
// list, merging opts per layer: baseOpts < config.defaults < group overrides < computed
// deviceType/mac. Throws with a clear message on any shape/collision problem.
function loadFleetConfig(config, baseOpts) {
  if (!config || !Array.isArray(config.devices) || config.devices.length === 0) {
    throw new Error('fleet config: "devices" must be a non-empty array');
  }
  if (config.defaults && Object.prototype.hasOwnProperty.call(config.defaults, 'mac')) {
    throw new Error('fleet config: "defaults.mac" is not supported — set "mac" per device group instead');
  }
  const defaults = config.defaults || {};

  const typeCounters = new Map(); // type -> next global index (for auto-generated MACs)
  const nextTypeIndex = (type) => {
    const n = (typeCounters.get(type) || 0) + 1;
    typeCounters.set(type, n);
    return n;
  };

  const instances = [];
  config.devices.forEach((group, gi) => {
    if (!group || typeof group.type !== 'string' || !group.type) {
      throw new Error(`fleet config: devices[${gi}] is missing a "type"`);
    }
    const count = group.count === undefined ? 1 : group.count;
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`fleet config: devices[${gi}] ("${group.type}") has invalid "count" ${JSON.stringify(group.count)} — must be a positive integer`);
    }
    const { type, count: _count, mac: groupMac, ...overrides } = group;
    if (overrides.capabilities !== undefined
      && (!Array.isArray(overrides.capabilities) || !overrides.capabilities.every((c) => typeof c === 'string'))) {
      throw new Error(`fleet config: devices[${gi}] ("${group.type}") "capabilities" must be an array of capability_key strings`);
    }

    for (let i = 1; i <= count; i++) {
      // One global counter per type (not per group), so a second group of the same type
      // continues numbering instead of colliding with the first (e.g. two separate
      // { type: "ESP32S3_MINI", count: 2 } entries yield #01-#02 then #03-#04).
      const idx = nextTypeIndex(type);
      const mac = groupMac
        ? (count === 1 ? groupMac : `${groupMac}-${pad(idx)}`)
        : `SIM-${type}-${pad(idx)}`;
      const opts = {
        ...compact(baseOpts),
        ...compact(defaults),
        ...compact(overrides),
        deviceType: type,
        mac,
      };
      instances.push({ label: `${shortLabel(type)}#${pad(idx)}`, opts });
    }
  });

  checkMacCollisions(instances);
  return instances;
}

function checkMacCollisions(instances) {
  const seen = new Map();
  for (const { opts } of instances) {
    if (seen.has(opts.mac)) {
      throw new Error(`fleet config: duplicate mac "${opts.mac}" (devices ${seen.get(opts.mac)} and ${opts.deviceType}) — give each device group a unique "mac" or omit it to auto-generate one`);
    }
    seen.set(opts.mac, opts.deviceType);
  }
}

module.exports = { compact, loadFleetConfig, checkMacCollisions, shortLabel };
