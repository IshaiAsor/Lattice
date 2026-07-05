#!/usr/bin/env node
// CLI wrapper around the SimDevice library (lib/sim-device.js). Reads config from env (or a
// fleet config file for multiple devices), wires each device's events to console output, and
// handles Ctrl-C. The device logic itself lives in the library so it can also be imported by
// automated tests. See README.md and PARITY.md.
//
// Single device (env-driven):
//   node tools/device-sim/index.js
//
// Fleet (config-driven — several devices/types at once, see fleet.example.json):
//   node tools/device-sim/index.js fleet.json
//   node tools/device-sim/index.js --config fleet.json
//   FLEET_CONFIG=fleet.json node tools/device-sim/index.js
//   DRY_RUN=true node tools/device-sim/index.js fleet.json   # print computed opts, don't start
//
// Env (defaults): API_URL=http://localhost:3100  GATEWAY_URL=http://localhost:3004
//   MQTT_HOST=127.0.0.1  MQTT_PORT=1883  SIM_USER=admin  SIM_PASS=admin
//   DEVICE_TYPE=ESP32S3_MINI  MAC=SIM-AA:BB:CC:DD:EE:01  TELEMETRY_MS=5000  CAMERA_MS=2000
//   CONFIG_REFRESH_MS=60000 (0 disables)  ACTIVATE_ALL=true  CAMERA=true  RESTART_ON_LOSS=false
//   OTA_FAIL=false  PERSIST=true  CLEANUP_ON_EXIT=false
//   REFRESH_LEAD_MS=450000 (refresh the device JWT this long before it expires — lower this to
//   force a near-immediate refresh-token exercise, e.g. REFRESH_LEAD_MS=86399000 against the
//   default 86400s JWT_DEVICE_USAGE_EXPIRES_IN)
//   CAPABILITIES=outlet,temperature (comma-separated catalog capability_keys — activate only
//   these instead of every catalog capability; overrides ACTIVATE_ALL's "everything" behavior)
// In fleet mode, the connection/credential vars above (API_URL, GATEWAY_URL, MQTT_*, SIM_USER/
// SIM_PASS) are shared by every device; DEVICE_TYPE/MAC/TELEMETRY_MS/etc. are ignored in favor
// of the config file's per-device-group settings.

const fs = require('fs');
const path = require('path');
const { SimDevice } = require('./lib/sim-device');
const { compact, loadFleetConfig } = require('./lib/fleet-config');

const num = (v, d) => (v === undefined ? d : parseInt(v, 10));
const bool = (v, d) => (v === undefined ? d : v !== 'false');
const list = (v) =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared connection/credential opts, sourced from env. Built via `compact` so an unset var is
// simply an absent key — spreading an explicit `undefined` value would overwrite SimDevice's
// own defaults instead of falling back to them.
const baseOpts = compact({
  apiUrl: process.env.API_URL,
  gatewayUrl: process.env.DEVICE_GATEWAY_URL,
  mqttHost: process.env.MQTT_SERVER_NAME,
  mqttPort: num(process.env.MQTT_PORT, undefined),
  // Default to the seeded owner (OWNER_USERNAME/OWNER_PASSWORD) so the sim logs in as the exact
  // credential admin the seed created; SIM_USER/SIM_PASS override, then a last-resort admin/admin.
  user: process.env.SIM_USER || process.env.OWNER_USERNAME || 'admin',
  pass: process.env.SIM_PASS || process.env.OWNER_PASSWORD || 'admin',
  telemetryMs: num(process.env.TELEMETRY_MS, undefined),
  cameraMs: num(process.env.CAMERA_MS, undefined),
  cameraResolution: process.env.CAMERA_RESOLUTION,
  cameraTransport: process.env.CAMERA_TRANSPORT,
  configRefreshMs: num(process.env.CONFIG_REFRESH_MS, undefined),
  refreshLeadMs: num(process.env.REFRESH_LEAD_MS, undefined),
  activateAll: bool(process.env.ACTIVATE_ALL, undefined),
  capabilities: list(process.env.CAPABILITIES),
  camera: bool(process.env.CAMERA, undefined),
  restartOnLoss: bool(process.env.RESTART_ON_LOSS, undefined),
  otaFail: bool(process.env.OTA_FAIL, undefined),
  persist: bool(process.env.PERSIST, undefined),
});

const CLEANUP_ON_EXIT = process.env.CLEANUP_ON_EXIT === 'true';

const configFlagIdx = process.argv.indexOf('--config');
const configPath =
  (configFlagIdx !== -1 && process.argv[configFlagIdx + 1]) ||
  process.argv.slice(2).find((a) => !a.startsWith('-')) ||
  process.env.FLEET_CONFIG ||
  null;

if (!configPath) {
  // ── legacy single-device mode (unchanged behavior) ─────────────────────────
  const dev = new SimDevice({
    ...baseOpts,
    deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
    mac: process.env.MAC || 'SIM-AA:BB:CC:DD:EE:01',
    log: console.log,
  });

  dev.on('error', (e) => console.error('✗', e.message || e));
  dev.on('hard-reset', async () => {
    console.log('hard-reset complete — exiting (re-run the sim to re-onboard)');
    process.exit(0);
  });

  const shutdown = async () => {
    if (CLEANUP_ON_EXIT) {
      await dev.cleanup();
      console.log('cleaned up device');
    } else await dev.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  dev.start().catch((e) => {
    console.error('✗', e.message || e);
    process.exit(1);
  });
  return; // top-level return is valid here — Node wraps CJS modules in a function
}

// ── fleet mode (config-driven, multiple devices) ────────────────────────────
let raw;
try {
  raw = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
} catch (e) {
  console.error(`✗ failed to read/parse fleet config "${configPath}": ${e.message}`);
  process.exit(1);
}

let instances;
try {
  instances = loadFleetConfig(raw, baseOpts);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

if (process.env.DRY_RUN === 'true') {
  for (const { label, opts } of instances) console.log(`[${label}]`, opts);
  console.log(`(dry run — ${instances.length} device(s) computed, none started)`);
  process.exit(0);
}

console.log(`▶ fleet config: ${configPath} — ${instances.length} device(s)`);

const fleet = instances.map(({ label, opts }) => {
  const dev = new SimDevice({ ...opts, log: (...a) => console.log(`[${label}]`, ...a) });
  dev.on('error', (e) => console.error(`✗ [${label}]`, e.message || e));
  dev.on('hard-reset', () => {
    // The library already calls stop() on itself before emitting this — just note it went
    // offline. Unlike single-device mode, one device's hard-reset doesn't end the process.
    console.log(`[${label}] hard-reset complete — device offline (re-run the sim to re-onboard)`);
  });
  return { label, dev };
});

const shutdown = async () => {
  await Promise.allSettled(fleet.map(({ dev }) => (CLEANUP_ON_EXIT ? dev.cleanup() : dev.stop())));
  console.log(`cleaned up ${fleet.length} device(s)`);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const STAGGER_MS = 150;
(async () => {
  for (const [i, { label, dev }] of fleet.entries()) {
    if (i > 0) await sleep(STAGGER_MS);
    dev.start().catch((e) => console.error(`✗ [${label}]`, e.message || e));
  }
})();
