'use strict';
// SimDevice — an importable software ESP device. Pure HTTP + MQTT (+ camera WS/HTTP), mirroring
// real firmware as closely as possible so it can both run as a CLI and be driven from automated
// tests. See ../PARITY.md for the firmware↔sim feature matrix.
//
//   const { SimDevice } = require('./lib/sim-device');
//   const dev = new SimDevice({ deviceType: 'ESP32S3_CAM', log: console.log });
//   await dev.start();
//   const cmd = await dev.waitFor('command', (c) => c.action === 'outlet', 3000);

const EventEmitter = require('events');
const os = require('os');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');
const { validate, normalize } = require('./command-models');
const { makeFrame } = require('./jpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Node clamps setTimeout delays above this (~24.8 days) to fire almost immediately instead of
// throwing, which turns a long-lived device JWT (JWT_DEVICE_USAGE_EXPIRES_IN can be up to a
// year) into a tight refresh-token loop. Cap and re-check instead of scheduling the raw delay.
const MAX_TIMEOUT_MS = 0x7fffffff;
// Tolerate a scheme-less base URL (e.g. API_URL=localhost:3010) — fetch() requires a scheme.
const withScheme = (u) => (u && !/^https?:\/\//i.test(u) ? `http://${u}` : u);
const isCamera = (impl) => /camera|stream|picture/i.test(impl || '');
// Unified CameraAction picks WS vs HTTP via its own camera_transport config field (default
// 'http'), not a distinct implementation_type — the old per-transport action classes are gone.
const isHttpCamera = (a) => (a.camera_transport || 'http') !== 'ws';
// Whether an action instance has a given behavior enabled (unified action model). The device
// config serves a `behaviors` list; absent/empty → all enabled (backward compat), mirroring
// firmware DeviceAction's all-true defaults.
const hasBehavior = (a, name) =>
  !Array.isArray(a.behaviors) || a.behaviors.length === 0
    ? true
    : a.behaviors.some((b) => b.behavior === name);

// Strictly-greater semver compare ("v2.0.165"), matching firmware OtaService::isNewerVersion.
function isNewer(a, b) {
  const p = (s) =>
    String(s)
      .replace(/^[vV]/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const [aM, aMi, aP] = p(a);
  const [bM, bMi, bP] = p(b);
  if (aM !== bM) return aM > bM;
  if (aMi !== bMi) return aMi > bMi;
  return aP > bP;
}

// Plausible per-implementation_type readings with a slow sine drift so threshold rules can cross.
const BANDS = {
  TemperatureAction: [18, 30],
  AirTemperatureAction: [18, 32],
  HumidityAction: [35, 75],
  WaterLevelAction: [0, 100],
  PhLevelAction: [5.5, 7.5],
  TdsLevelAction: [400, 1200],
  CO2LevelAction: [400, 1500],
};
function reading(impl, seed, t) {
  const [lo, hi] = BANDS[impl] || [0, 100];
  const phase = Math.sin(t / 6 + seed);
  const noise = (Math.random() - 0.5) * (hi - lo) * 0.02;
  return Math.round((lo + ((phase + 1) / 2) * (hi - lo) + noise) * 10) / 10;
}

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'),
    );
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// WebSocket factory: prefer the `ws` package (consistent Node event API), fall back to a global
// WebSocket (Node >=22). Normalises the two event APIs.
function makeWs(url, { onOpen, onClose, onError }) {
  let Impl;
  try {
    Impl = require('ws');
  } catch {
    Impl = global.WebSocket;
  }
  if (!Impl) throw new Error("no WebSocket available — install 'ws' or use Node >=22");
  const ws = new Impl(url);
  if (typeof ws.on === 'function') {
    ws.on('open', onOpen);
    ws.on('close', onClose);
    ws.on('error', onError || (() => {}));
  } else {
    try {
      ws.binaryType = 'arraybuffer';
    } catch {}
    ws.addEventListener('open', onOpen);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError || (() => {}));
  }
  return ws;
}

const DEFAULTS = {
  apiUrl: 'http://localhost:3100',
  gatewayUrl: 'http://localhost:3004',
  mqttHost: '127.0.0.1',
  mqttPort: 1883,
  mqttUrl: null, // full broker URL (e.g. mqtts://host:8883 for TLS); overrides mqttHost/mqttPort
  user: 'admin',
  pass: 'admin',
  deviceType: 'ESP32S3_MINI',
  mac: 'SIM-AA:BB:CC:DD:EE:01',
  telemetryMs: 5000,
  heartbeatMs: 60000, // liveness ping cadence (firmware HEARTBEAT_INTERVAL_MS)
  failTelemetry: [], // action names whose reads emit a fault envelope instead of a value

  cameraMs: 2000,
  cameraResolution: 'SVGA', // sent when auto-activating a CameraAction capability
  cameraTransport: 'http', // 'http' or 'ws'
  configRefreshMs: 60000, // 0 disables the periodic re-pull (real firmware only pulls at boot)
  activateAll: true,
  autoTelemetry: true, // run telemetry + config-refresh loops in start()
  camera: true, // stream camera frames for activated camera capabilities
  persist: true, // NVS analog: persist command state to disk
  statePath: null, // defaults to a per-MAC file under os.tmpdir()
  restartOnLoss: false, // mimic firmware ESP.restart on connection loss (vs auto-reconnect)
  otaFail: false, // simulate a failed OTA (ack failed, no reboot)
  rebootMs: 1500, // simulated reboot downtime
  refreshLeadMs: 450000, // refresh the device JWT this long before exp (firmware JWT_REFRESH_POLICY)
  log: () => {},
};

class SimDevice extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.opts.apiUrl = withScheme(this.opts.apiUrl);
    this.opts.gatewayUrl = withScheme(this.opts.gatewayUrl);
    this._log = this.opts.log || (() => {});
    // identity / connection (reset by (re)provision)
    this.appToken = null;
    this.userId = null;
    this.catalogCaps = null;
    // Sealed = factory-soldered: config is composed by an admin (sealed template) and
    // auto-materialized by device-gateway on provision. The sim never self-activates capabilities
    // for these — it just pulls the served config, exactly like sealed firmware. Set from catalog.
    this.isSealed = false;
    this.version = null;
    this.deviceId = null;
    this.mqttToken = null;
    this.refreshToken = null;
    this.refreshUrl = null;
    this.deviceConfigUrl = null;
    this.wsStreamUrl = null;
    this.cameraHttpUrl = null;
    this.client = null;
    this.actions = [];
    // internal bookkeeping
    this._lastPub = new Map();
    this._lastState = new Map();
    this._durationTimers = new Map();
    /** action → epoch seconds the hold ends. Persisted, unlike the timer above. */
    this._deadlines = new Map();
    this._cameraConns = new Map();
    this._timers = [];
    this._refreshTimer = null;
    this._configTimer = null;
    this._t = 0;
    this._bootAt = Date.now(); // uptime origin for heartbeats
    // Runtime-toggleable fault injection: reads for these action names emit a fault envelope
    // (mirrors firmware BaseTelemetryAction on a failed read). Tests mutate this directly.
    this.faults = new Set(this.opts.failTelemetry || []);
    this._intentionalClose = false;
    this._stateFile =
      this.opts.statePath ||
      path.join(
        os.tmpdir(),
        'lattice-sim-state',
        `${String(this.opts.mac).replace(/[^\w.-]/g, '_')}.json`,
      );
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  async start() {
    await this.login();
    this._log(`✔ logged in as ${this.opts.user}`);
    await this.loadCatalog();
    this._log(
      `✔ catalog ${this.opts.deviceType} ${this.version} — ${this.catalogCaps.length} capabilities`,
    );
    await this.provision();
    this._log(`✔ provisioned — deviceId ${this.deviceId}`);
    // Sealed devices are admin-configured: device-gateway auto-materializes the released template
    // on provision, so the sim never self-activates — it just pulls the served config (matching
    // sealed firmware, and keeping the device-config page's read-only contract honest).
    if (this.isSealed) {
      this._log('🔒 sealed device — config is admin-composed; skipping capability self-activation');
    } else {
      // `capabilities` (a list of catalog capability_keys) activates just those, even if
      // activateAll is off — an explicit list is an explicit request to activate them.
      const wantsSelected =
        Array.isArray(this.opts.capabilities) && this.opts.capabilities.length > 0;
      if (this.opts.activateAll || wantsSelected) {
        const { activated, skipped } = await this.activateAll();
        this._log(
          `✔ activated ${activated} capabilit${activated === 1 ? 'y' : 'ies'} via api (skipped ${skipped} already configured)`,
        );
      }
    }
    this._loadStateFile();
    const { tel, cmd, cam } = await this.pullConfig();
    this._log(
      `✔ pulled config — ${this.actions.length} action(s): ${tel} telemetry, ${cmd} command, ${cam} camera`,
    );
    if (this.actions.length === 0) {
      this._log(
        this.isSealed
          ? `  (no released sealed template covers ${this.opts.deviceType} ${this.version} yet — compose + release one in Admin › Sealed Templates; re-pulls every ${this.opts.configRefreshMs}ms)`
          : `  (nothing activated yet — activate capabilities in the device-config UI; re-pulls every ${this.opts.configRefreshMs}ms)`,
      );
    }
    await this.connect();
    this._scheduleRefresh();
    if (this.opts.autoTelemetry) this._startLoops();
    if (this.opts.camera) this._startCamera();
    this._log(
      '▶ running — honours per-type commands, duration auto-off, refresh, camera, restart/soft-reset/hard-reset/OTA',
    );
    return this;
  }

  async login() {
    const r = await this._http('POST', `${this.opts.apiUrl}/api/auth/login`, null, {
      username: this.opts.user,
      password: this.opts.pass,
    });
    // /auth/login returns { token, refreshToken }; older builds returned a bare JWT string.
    this.appToken = r && typeof r === 'object' && r.token ? r.token : r;
  }

  async loadCatalog() {
    const devices = await this._http(
      'GET',
      `${this.opts.apiUrl}/api/admin/catalog/devices`,
      this.appToken,
    );
    const dev = devices
      .filter((d) => d.type === this.opts.deviceType)
      .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1))[0];
    if (!dev)
      throw new Error(
        `no catalog device for type ${this.opts.deviceType} — seed the catalog first`,
      );
    this.version = dev.version;
    this.isSealed = !!dev.is_sealed;
    this.catalogCaps = await this._http(
      'GET',
      `${this.opts.apiUrl}/api/admin/catalog/devices/${dev.id}/capabilities`,
      this.appToken,
    );
  }

  async provision() {
    const { provisioningToken, userId } = await this._http(
      'GET',
      `${this.opts.gatewayUrl}/api/provisioning/provision-token`,
      this.appToken,
    );
    this.userId = userId;
    const prov = await this._http(
      'POST',
      `${this.opts.gatewayUrl}/api/provisioning/provision`,
      provisioningToken,
      {
        macAddress: this.opts.mac,
        deviceType: this.opts.deviceType,
        version: this.version,
        capabilities: this.catalogCaps.map((c) => ({
          capability_key: c.capability_key,
          label: c.label,
          implementation_type: c.implementation_type,
          mqtt_action_type: c.mqtt_action_type,
          mqtt_action_name: c.mqtt_action_name,
        })),
      },
    );
    this.deviceId = prov.deviceId;
    this.mqttToken = prov.mqttToken;
    this.refreshToken = prov.refreshToken;
    this.refreshUrl = prov.refreshTokenCallbackUrl;
    this.deviceConfigUrl = prov.deviceConfigUrl;
    this.wsStreamUrl = prov.wsStreamUrl;
    this.cameraHttpUrl = prov.cameraHttpUrl;
    return { deviceId: this.deviceId, mqttToken: this.mqttToken };
  }

  // Activate catalog capabilities through the real api (the device-config page's own call).
  // With `opts.capabilities` set (an array of catalog `capability_key`s, e.g. "outlet",
  // "temperature"), only those are activated; otherwise every catalog capability is.
  async activateAll() {
    const view = await this._http(
      'GET',
      `${this.opts.apiUrl}/api/devices/${this.deviceId}/capabilities`,
      this.appToken,
    );
    const filter = Array.isArray(this.opts.capabilities) ? this.opts.capabilities : null;
    const candidates = filter ? view.filter((cap) => filter.includes(cap.capability_key)) : view;
    if (filter) {
      const found = new Set(candidates.map((c) => c.capability_key));
      for (const key of filter)
        if (!found.has(key))
          this._log(
            `⚠ requested capability "${key}" not found in catalog for ${this.opts.deviceType} — skipping`,
          );
    }
    let activated = 0;
    for (const cap of candidates) {
      if (cap.instances.length > 0) continue; // idempotent across runs
      const camera = isCamera(cap.implementation_type);
      await this._http(
        'POST',
        `${this.opts.apiUrl}/api/devices/${this.deviceId}/actions`,
        this.appToken,
        {
          capability_id: cap.id,
          telemetry_interval_ms:
            cap.mqtt_action_type === 'telemetry'
              ? (cap.min_telemetry_interval_ms ?? this.opts.telemetryMs)
              : null,
          pins: cap.configurable_pins.map((p, i) => ({
            capability_pin_id: p.id,
            pin_number: 10 + i,
          })),
          camera_resolution: camera ? this.opts.cameraResolution : null,
          camera_transport: camera ? this.opts.cameraTransport : null,
        },
      );
      activated++;
    }
    return { activated, skipped: candidates.length - activated };
  }

  // PULL configuration — only the device's own active actions (firmware loadFromServer).
  async pullConfig() {
    const cfg = await this._http(
      'GET',
      `${this.deviceConfigUrl}?deviceId=${this.deviceId}&version=${this.version}`,
      this.mqttToken,
    );
    this.actions = cfg.actions || [];
    for (const a of this.actions) {
      if (a.pins && a.pins.length) {
        this._log(
          `[Config] ${a.mqtt_action_name} (${a.implementation_type}) pins: ${a.pins.map((p) => `GPIO${p.pinNumber}/${p.pinMode}`).join(', ')}`,
        );
      }
    }
    const tel = this.actions.filter(
      (a) => a.mqtt_action_type === 'telemetry' && !isCamera(a.implementation_type),
    ).length;
    const cmd = this.actions.filter((a) => a.mqtt_action_type === 'command').length;
    const cam = this.actions.filter((a) => isCamera(a.implementation_type)).length;
    this.emit('config', { actions: this.actions, tel, cmd, cam });
    return { tel, cmd, cam };
  }

  connect() {
    return new Promise((resolve) => {
      let resolved = false;
      this._intentionalClose = false;
      const brokerUrl = this.opts.mqttUrl || `mqtt://${this.opts.mqttHost}:${this.opts.mqttPort}`;
      this.client = mqtt.connect(brokerUrl, {
        username: String(this.userId),
        clientId: String(this.deviceId),
        password: this.mqttToken,
        reconnectPeriod: this.opts.restartOnLoss ? 0 : 2000,
        will: { topic: this._statusTopic(), payload: 'offline', retain: true, qos: 0 },
      });
      this.client.on('error', (e) => this._emitErr(e));
      this.client.on('message', (t, p) => this._onMessage(t, p));
      this.client.on('close', () => {
        if (this._intentionalClose) return;
        this.emit('offline', {});
        if (this.opts.restartOnLoss) {
          this._log('⚠ connection lost — restarting (restartOnLoss)');
          this.reboot().catch((e) => this._emitErr(e));
        }
      });
      this.client.on('connect', () => {
        this._log(`✔ MQTT connected (v${this.version})`);
        this.client.publish(this._statusTopic(), 'online', { retain: true });
        // One subscription, matching firmware's mqtt.h: a firmware update arrives as the `ota`
        // command verb on this same per-device topic. The fleet-wide `ota/updates/<deviceType>`
        // broadcast is gone from both sides — it addressed a device *type*, so one Update press
        // flashed every connected device of that type.
        this.client.subscribe(`${this._base()}/+/command/#`);
        // Boot/reboot state restore: republish last command states as unsolicited acks.
        for (const [action, value] of this._lastState) {
          this._publishAck(action, { status: 'ok', value, unsolicited: true });
        }
        this.emit('connect', { version: this.version });
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
    });
  }

  // ── MQTT message handling ────────────────────────────────────────────────
  async _onMessage(topic, payload) {
    const msg = payload.toString();

    const parts = topic.split('/');
    const ci = parts.indexOf('command');
    if (ci === -1) return;
    const action = parts.slice(ci + 1).join('/');

    // Control commands — firmware reboots and does NOT ack these.
    if (action === 'restart') {
      this._log('↻ restart command — rebooting (creds kept)');
      await this.reboot();
      return;
    }
    if (action === 'soft-reset' || action === 'reprovision') {
      this._log('↻ soft-reset command — clearing creds + re-provisioning');
      await this.reboot({ reprovision: true });
      return;
    }
    if (action === 'hard-reset') {
      this._log('⚑ hard-reset command — factory wipe; going offline');
      this.emit('hard-reset', {});
      await this.stop();
      return;
    }
    // Firmware update — now the only way one arrives, mirroring firmware's
    // MqttActionsHandlerService. The topic names this device, so an update reaches it alone.
    if (action === 'ota') {
      await this._handleOta(msg);
      return;
    }
    if (action === 'take_picture') {
      let cmd;
      try {
        cmd = JSON.parse(msg);
      } catch {
        cmd = {};
      }
      const camAction = this.actions.find((a) => isCamera(a.implementation_type));
      if (!camAction) {
        this._log('📷 take_picture received but no camera configured — ignoring');
        return;
      }
      this._log(`📷 on-demand capture requested (commandId=${cmd.commandId || ''})`);
      this._sendOnDemandFrame(camAction, cmd.commandId).catch((e) => this._emitErr(e));
      return;
    }

    // Normal action command: { value, duration, commandId }.
    let cmd;
    try {
      cmd = JSON.parse(msg);
    } catch {
      cmd = { value: msg };
    }
    const meta = this.actions.find((a) => a.mqtt_action_name === action) || {};

    // Reserved `read` verb: report current state without validating or mutating — mirrors
    // firmware's pre-validation interception. On a command action, answer from _lastState on the
    // ack topic (state query, e.g. after a restart). On a read-surface (telemetry) action with
    // the `on_demand` behavior, publish a fresh reading envelope; without it, reject.
    if (cmd.value === 'read') {
      if (meta.mqtt_action_type === 'command') {
        const value = this._lastState.get(action) ?? '';
        this._log(`⇐ read ${action} → state "${value}" (cmd ${cmd.commandId || ''})`);
        this._publishAck(action, { status: 'ok', value, commandId: cmd.commandId });
      } else if (meta.mqtt_action_type === 'telemetry' && !isCamera(meta.implementation_type)) {
        if (hasBehavior(meta, 'on_demand')) {
          const value = reading(meta.implementation_type, action.length, this._t);
          this._log(`⇐ read ${action} → ${value} (cmd ${cmd.commandId || ''})`);
          this.publishTelemetry(
            action,
            JSON.stringify({ value: String(value), commandId: cmd.commandId }),
          );
        } else {
          this._publishAck(action, {
            status: 'error',
            value: 'on_demand_disabled',
            commandId: cmd.commandId,
          });
        }
      }
      return;
    }

    // Value commands are gated on the `command` behavior.
    if (meta.mqtt_action_type === 'command' && !hasBehavior(meta, 'command')) {
      this._log(`⇐ command ${action} rejected — no command behavior`);
      this._publishAck(action, {
        status: 'error',
        value: 'command_disabled',
        commandId: cmd.commandId,
      });
      return;
    }

    const impl = meta.implementation_type;
    const ok = validate(impl, cmd.value);
    const value = ok ? normalize(cmd.value) : cmd.value;
    const ack = { status: ok ? 'ok' : 'error', value };
    if (cmd.commandId) ack.commandId = cmd.commandId;
    this._log(
      `⇐ command ${action} = ${JSON.stringify(cmd.value)}${ok ? '' : ' (INVALID)'}${cmd.commandId ? ` (cmd ${cmd.commandId})` : ''} → ack ${ack.status}`,
    );
    this._publishAck(action, ack);
    this.emit('command', {
      action,
      value: cmd.value,
      commandId: cmd.commandId,
      duration: cmd.duration,
      valid: ok,
      impl,
    });
    if (!ok) return; // firmware does not change state on an invalid payload

    this._lastState.set(action, value);
    // Duration auto-off (seconds; "*" = none), mirroring BaseCommandAction::loop.
    clearTimeout(this._durationTimers.get(action));
    this._durationTimers.delete(action);
    this._deadlines.delete(action);
    const dur = cmd.duration;
    if (dur !== undefined && dur !== '*' && Number(dur) > 0) {
      // Persisted as an absolute epoch beside the state, mirroring DurationState::encode: the
      // firmware's countdown is millis()-based and so does not survive a reboot, which is exactly
      // when the deadline matters. Saved BEFORE the state file is written, so both land together.
      this._deadlines.set(action, Math.floor(Date.now() / 1000) + Number(dur));
      this._log(`  duration ${dur}s — will auto-off`);
      this._saveStateFile();
      this._durationTimers.set(
        action,
        setTimeout(
          () => {
            this._durationTimers.delete(action);
            this._deadlines.delete(action);
            this._lastState.set(action, 'off');
            this._saveStateFile();
            if (this.client && this.client.connected) {
              this._publishAck(action, { status: 'ok', value: 'off', unsolicited: true });
              this._log(`⏲ ${action} duration elapsed → auto-off (unsolicited ack)`);
            }
          },
          Number(dur) * 1000,
        ),
      );
    } else {
      this._saveStateFile();
    }
  }

  async _handleOta(msg) {
    let p;
    try {
      p = JSON.parse(msg);
    } catch {
      return;
    }
    if (!p.version || !p.url) return;
    if (!isNewer(p.version, this.version)) {
      this._log(`⊘ OTA ${p.version} ignored (current ${this.version}, not newer)`);
      this._publishAck('ota', { status: 'error', value: 'rejected:not-newer' });
      this.emit('ota', { from: this.version, to: p.version, accepted: false, reason: 'not-newer' });
      return;
    }
    if (this.opts.otaFail) {
      this._log(`⇩ OTA ${p.version} — simulating FAILED update`);
      this._publishAck('ota', { status: 'error', value: 'failed:simulated' });
      this.emit('ota', { from: this.version, to: p.version, accepted: false, reason: 'failed' });
      return;
    }
    this._log(`⇩ OTA ${this.version} → ${p.version} from ${p.url} — "flashing"...`);
    // Awaited, unlike every other ack: the reboot below force-closes the connection, so a
    // fire-and-forget publish here never leaves the process. Real firmware acks `starting:` over
    // a live link and only reboots after a multi-second HTTP download, so the platform always
    // sees this one — which is why it must reach the broker here too.
    await this._publishAck('ota', { status: 'ok', value: `starting:${p.version}` });
    this.emit('ota', { from: this.version, to: p.version, accepted: true });
    this.version = p.version; // adopt new firmware version
    await this.reboot(); // reconnect on the NEW version topic → current_firmware_version
  }

  // ── simulated reboot ─────────────────────────────────────────────────────
  async reboot({ reprovision = false } = {}) {
    this._bootAt = Date.now(); // reset uptime origin (firmware millis() resets on reboot)
    this._clearDurationTimers();
    this._stopCamera();
    this._intentionalClose = true;
    try {
      this.client && this.client.publish(this._statusTopic(), 'offline', { retain: true });
    } catch {}
    if (this.client) await new Promise((r) => this.client.end(true, {}, r));
    await sleep(this.opts.rebootMs);
    if (reprovision) {
      await this.provision();
      this._log(`  re-provisioned — deviceId ${this.deviceId}`);
    }
    await this.connect();
    const { tel, cmd } = await this.pullConfig();
    this._scheduleRefresh();
    if (this.opts.camera) this._startCamera();
    this.emit('reboot', { reprovision });
    this._log(`✔ back online — ${this.actions.length} action(s): ${tel} telemetry, ${cmd} command`);
  }

  // ── telemetry + config-refresh loops ─────────────────────────────────────
  _startLoops() {
    this._timers.push(
      setInterval(() => {
        this._t += 1;
        if (!this.client || !this.client.connected) return;
        const now = Date.now();
        for (const a of this.actions) {
          if (a.mqtt_action_type !== 'telemetry' || isCamera(a.implementation_type)) continue;
          if (!hasBehavior(a, 'interval')) continue; // on-demand-only sensors don't cycle
          const interval =
            a.telemetry_interval_ms && a.telemetry_interval_ms > 0
              ? a.telemetry_interval_ms
              : this.opts.telemetryMs;
          if (now - (this._lastPub.get(a.mqtt_action_name) ?? 0) < interval) continue;
          this._lastPub.set(a.mqtt_action_name, now);
          if (this.faults.has(a.mqtt_action_name)) {
            // Fault envelope — same shape firmware publishes on a failed read.
            this.publishTelemetry(
              a.mqtt_action_name,
              JSON.stringify({ error: 'read_failed', action: a.mqtt_action_name }),
            );
            continue;
          }
          this.publishTelemetry(
            a.mqtt_action_name,
            reading(a.implementation_type, a.mqtt_action_name.length, this._t),
          );
        }
      }, 1000),
    );

    // Liveness heartbeat — independent of telemetry, mirrors firmware handleHeartbeat().
    this._timers.push(
      setInterval(() => {
        if (!this.client || !this.client.connected) return;
        this.publishHeartbeat();
      }, this.opts.heartbeatMs),
    );

    // Periodic config re-pull is a sim convenience (real firmware only pulls at boot). It's a
    // no-op unless configRefreshMs > 0, and it never overlaps: it reschedules itself only after
    // the previous pull settles, so a slow/unreachable gateway can't pile up requests.
    if (this.opts.configRefreshMs > 0) {
      const scheduleRefresh = () => {
        this._configTimer = setTimeout(async () => {
          if (this.client && this.client.connected) {
            try {
              const { tel, cmd, cam } = await this.pullConfig();
              this._log(
                `↻ config refreshed — ${this.actions.length} action(s): ${tel} telemetry, ${cmd} command, ${cam} camera`,
              );
              if (this.opts.camera) this._startCamera();
            } catch (e) {
              this._emitErr(e);
            }
          }
          scheduleRefresh();
        }, this.opts.configRefreshMs);
      };
      scheduleRefresh();
    }
  }

  publishTelemetry(name, value) {
    if (this.client)
      this.client.publish(`${this._base()}/${this.version}/telemetry/${name}`, String(value));
    this.emit('telemetry', { action: name, value });
  }

  publishStatus(status) {
    if (this.client) this.client.publish(this._statusTopic(), status, { retain: true });
  }

  // Mirrors firmware MqttService::publishHeartbeat — best-effort liveness ping with cheap
  // diagnostics. freeHeap/rssi are plausible fixed-ish values (no real hardware).
  publishHeartbeat() {
    if (!this.client) return;
    const body = {
      uptimeMs: Date.now() - this._bootAt,
      freeHeap: 200000,
      rssi: -55,
      version: this.version,
    };
    this.client.publish(`${this._base()}/${this.version}/heartbeat`, JSON.stringify(body));
    this.emit('heartbeat', body);
  }

  // ── camera (WS + HTTP) ───────────────────────────────────────────────────
  _startCamera() {
    const camActions = this.actions.filter((a) => isCamera(a.implementation_type));
    const wanted = new Set(
      camActions.map((a) => (isHttpCamera(a) ? `http:${a.mqtt_action_name}` : a.mqtt_action_name)),
    );
    for (const [key, conn] of this._cameraConns) {
      if (!wanted.has(key)) {
        try {
          conn.close();
        } catch {}
        this._cameraConns.delete(key);
      }
    }
    for (const a of camActions) {
      if (isHttpCamera(a)) {
        const key = `http:${a.mqtt_action_name}`;
        if (this._cameraConns.has(key)) continue;
        const interval =
          a.telemetry_interval_ms && a.telemetry_interval_ms > 0
            ? a.telemetry_interval_ms
            : this.opts.cameraMs;
        const tmr = setInterval(
          () => this._sendHttpFrame(a.mqtt_action_name).catch((e) => this._emitErr(e)),
          interval,
        );
        this._cameraConns.set(key, { close: () => clearInterval(tmr) });
      } else {
        if (this._cameraConns.has(a.mqtt_action_name)) continue;
        this._openStreamWs(a);
      }
    }
  }

  _openStreamWs(a) {
    // Both /ws/stream and /ws/capture behave identically server-side (device-gateway's
    // ws/camera-stream.ts republishes either the same way) — CameraAction always connects
    // to /ws/stream now that the old per-purpose action classes are gone.
    const url = `${this.wsStreamUrl.replace(/^http/, 'ws')}/ws/stream?token=${encodeURIComponent(this.mqttToken)}&action=${encodeURIComponent(a.mqtt_action_name)}`;
    const interval =
      a.telemetry_interval_ms && a.telemetry_interval_ms > 0
        ? a.telemetry_interval_ms
        : this.opts.cameraMs;
    let frameTmr = null;
    let sending = false; // re-entrancy guard: skip a tick if the previous frame is still encoding
    const ws = makeWs(url, {
      onOpen: () => {
        this._log(`📷 ${a.mqtt_action_name} WS /ws/stream open`);
        frameTmr = setInterval(() => {
          if (sending) return;
          sending = true;
          makeFrame()
            .then((frame) => {
              try {
                ws.send(frame);
                this.emit('camera-frame', {
                  action: a.mqtt_action_name,
                  transport: 'ws',
                  bytes: frame.length,
                });
              } catch {}
            })
            .catch((e) => this._emitErr(e))
            .finally(() => {
              sending = false;
            });
        }, interval);
      },
      onClose: () => {
        if (frameTmr) clearInterval(frameTmr);
      },
      onError: (e) => this._log(`📷 ${a.mqtt_action_name} WS error: ${(e && e.message) || e}`),
    });
    this._cameraConns.set(a.mqtt_action_name, {
      ws,
      close: () => {
        if (frameTmr) clearInterval(frameTmr);
        try {
          ws.close();
        } catch {}
      },
    });
  }

  async _sendHttpFrame(name, commandId) {
    const frame = await makeFrame();
    const qs = commandId ? `&commandId=${encodeURIComponent(commandId)}` : '';
    await this._httpRaw(
      `${this.cameraHttpUrl}/api/camera/frame?action=${encodeURIComponent(name)}${qs}`,
      this.mqttToken,
      frame,
      'image/jpeg',
    );
    this.emit('camera-frame', { action: name, transport: 'http', bytes: frame.length, commandId });
  }

  // On-demand capture (CameraAction::triggerCapture equivalent) — used to answer a
  // take_picture command, independent of whether periodic camera streaming is running.
  async _sendOnDemandFrame(a, commandId) {
    if (isHttpCamera(a)) {
      await this._sendHttpFrame(a.mqtt_action_name, commandId);
      return;
    }
    // WS: reuse the persistent connection if one is open; otherwise open a transient one for
    // this single frame. Either way, a small JSON text frame carrying commandId precedes the
    // binary frame — mirrors CameraAction's WS pairing convention (see device-gateway's
    // ws/camera-stream.ts).
    const frame = await makeFrame();
    const existing = this._cameraConns.get(a.mqtt_action_name);
    if (existing && existing.ws && existing.ws.readyState === 1) {
      try {
        existing.ws.send(JSON.stringify({ commandId }));
        existing.ws.send(frame);
        this.emit('camera-frame', {
          action: a.mqtt_action_name,
          transport: 'ws',
          bytes: frame.length,
          commandId,
        });
      } catch (e) {
        this._emitErr(e);
      }
      return;
    }
    const url = `${this.wsStreamUrl.replace(/^http/, 'ws')}/ws/stream?token=${encodeURIComponent(this.mqttToken)}&action=${encodeURIComponent(a.mqtt_action_name)}`;
    await new Promise((resolve) => {
      const ws = makeWs(url, {
        onOpen: () => {
          try {
            ws.send(JSON.stringify({ commandId }));
            ws.send(frame);
            this.emit('camera-frame', {
              action: a.mqtt_action_name,
              transport: 'ws',
              bytes: frame.length,
              commandId,
            });
          } catch (e) {
            this._emitErr(e);
          }
          setTimeout(() => {
            try {
              ws.close();
            } catch {}
            resolve();
          }, 200);
        },
        onError: (e) => {
          this._log(`📷 ${a.mqtt_action_name} on-demand WS error: ${(e && e.message) || e}`);
          resolve();
        },
        onClose: () => resolve(),
      });
    });
  }

  _stopCamera() {
    for (const conn of this._cameraConns.values()) {
      try {
        conn.close();
      } catch {}
    }
    this._cameraConns.clear();
  }

  // ── refresh-token rotation ───────────────────────────────────────────────
  _scheduleRefresh() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    const exp = decodeJwtExp(this.mqttToken);
    if (!exp) return; // no exp claim → nothing to schedule
    const delay = Math.max(exp * 1000 - Date.now() - this.opts.refreshLeadMs, 1000);
    if (delay > MAX_TIMEOUT_MS) {
      this._refreshTimer = setTimeout(() => this._scheduleRefresh(), MAX_TIMEOUT_MS);
      return;
    }
    this._refreshTimer = setTimeout(
      () => this.refreshTokenNow().catch((e) => this._emitErr(e)),
      delay,
    );
  }

  async refreshTokenNow() {
    if (!this.refreshToken) return;
    const url = this.refreshUrl || `${this.opts.gatewayUrl}/api/provisioning/refresh-token`;
    const r = await this._http('POST', url, null, { refreshToken: this.refreshToken });
    this.mqttToken = r.mqttToken;
    this.refreshToken = r.refreshToken;
    this.deviceConfigUrl = r.deviceConfigUrl || this.deviceConfigUrl;
    this.wsStreamUrl = r.wsStreamUrl || this.wsStreamUrl;
    this.cameraHttpUrl = r.cameraHttpUrl || this.cameraHttpUrl;
    this._log('🔑 refreshed device token');
    this.emit('refresh', {});
    this._scheduleRefresh();
  }

  // ── shutdown ─────────────────────────────────────────────────────────────
  async stop() {
    this._intentionalClose = true;
    for (const tm of this._timers) clearInterval(tm);
    this._timers = [];
    this._clearDurationTimers();
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._configTimer) {
      clearTimeout(this._configTimer);
      this._configTimer = null;
    }
    this._stopCamera();
    try {
      this.client && this.client.publish(this._statusTopic(), 'offline', { retain: true });
    } catch {}
    if (this.client) await new Promise((r) => this.client.end(false, {}, r));
    this.client = null;
  }

  async cleanup() {
    await this.stop();
    if (this.deviceId && this.appToken) {
      await this._http(
        'DELETE',
        `${this.opts.apiUrl}/api/devices/${this.deviceId}`,
        this.appToken,
      ).catch(() => {});
    }
  }

  // ── test hook ────────────────────────────────────────────────────────────
  // Resolves with the next `event` whose payload satisfies `predicate` (or the next event if no
  // predicate), rejecting after `timeoutMs`.
  waitFor(event, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const onEvt = (p) => {
        if (!predicate || predicate(p)) {
          cleanup();
          resolve(p);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitFor('${event}') timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(event, onEvt);
      };
      this.on(event, onEvt);
    });
  }

  // ── internals ────────────────────────────────────────────────────────────
  _base() {
    return `users/${this.userId}/devices/${this.deviceId}`;
  }
  _statusTopic() {
    return `${this._base()}/${this.version}/status`;
  }

  // Returns a promise that settles once the packet has been handed to the socket. Fire-and-forget
  // is fine for most callers, but anything that closes the connection right after acking must
  // await it: reboot() force-closes the client, which discards whatever is still queued. QoS stays
  // 0 — PubSubClient (the firmware's client) only publishes at QoS 0, so raising it here would be
  // a divergence, not a fidelity gain.
  _publishAck(action, { status, value, commandId, unsolicited }) {
    const body = { status, value };
    if (commandId) body.commandId = commandId;
    const sent = this.client
      ? new Promise((resolve) => {
          this.client.publish(
            `${this._base()}/${this.version}/ack/${action}`,
            JSON.stringify(body),
            {},
            () => resolve(),
          );
        })
      : Promise.resolve();
    this.emit('ack', { action, status, value, commandId, unsolicited: !!unsolicited });
    return sent;
  }

  _clearDurationTimers() {
    for (const tm of this._durationTimers.values()) clearTimeout(tm);
    this._durationTimers.clear();
  }

  _loadStateFile() {
    if (!this.opts.persist) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
      // Two shapes: the flat map written before deadlines existed, and { state, deadlines } after.
      // Reading both means an upgrade needs no migration, same as the firmware's `state|deadline`.
      const saved = data && data.state ? data.state : data;
      for (const [k, v] of Object.entries(saved || {})) this._lastState.set(k, v);

      // A hold that ended while the device was down must NOT come back on — the whole point of
      // persisting the deadline. Mirrors DurationState::planRestore.
      const now = Math.floor(Date.now() / 1000);
      let expired = 0;
      for (const [k, deadline] of Object.entries((data && data.deadlines) || {})) {
        if (now >= Number(deadline)) {
          this._lastState.set(k, 'off');
          expired++;
        } else {
          this._deadlines.set(k, Number(deadline));
        }
      }
      if (this._lastState.size)
        this._log(
          `[NVS] restored ${this._lastState.size} saved action state(s)` +
            (expired ? `, ${expired} timed hold(s) had expired -> off` : ''),
        );
    } catch {
      /* no saved state */
    }
  }

  _saveStateFile() {
    if (!this.opts.persist) return;
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      fs.writeFileSync(
        this._stateFile,
        JSON.stringify({
          state: Object.fromEntries(this._lastState),
          deadlines: Object.fromEntries(this._deadlines),
        }),
      );
    } catch {
      /* best effort */
    }
  }

  _emitErr(e) {
    if (this.listenerCount('error') > 0) this.emit('error', e);
    else this._log(`✗ ${(e && e.message) || e}`);
  }

  async _http(method, url, token, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new Error(
        `${method} ${url} → ${(e.cause && e.cause.code) || e.message} (is the service running?)`,
      );
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async _httpRaw(url, token, buf, contentType) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: buf,
    });
    if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`);
  }
}

module.exports = { SimDevice, isNewer, reading, BANDS };
