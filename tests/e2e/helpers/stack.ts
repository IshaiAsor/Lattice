// Shared helpers for end-to-end/sanity tests that drive a running stack via the SimDevice fixture.
//
// Environment targeting (see docs/TESTING.md):
//   TEST_TARGET=local   (default) — local stack; env from .env.test (preferred) or .env.
//   TEST_TARGET=staging — acceptance mode; everything comes from STAGING_*/E2E_BOT_* env vars
//                         (GH environment secrets), never from files. Missing vars throw.
//
// These suites need a reachable stack. When it's down they SKIP (not fail) — see `itStack` —
// so `npm test` is safe on a cold checkout.

import * as fs from 'fs';
import * as path from 'path';
import * as mqtt from 'mqtt';

export const TEST_TARGET: 'local' | 'staging' =
  process.env.TEST_TARGET === 'staging' ? 'staging' : 'local';

function requireStagingEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`TEST_TARGET=staging requires the ${name} environment variable`);
  return v;
}

// Best-effort: load the repo root's env file so tests can use the app MQTT (superuser)
// credentials. Prefers .env.test (the ephemeral compose.test.yaml stack — see
// compose.test.yaml) over .env (a developer's personal dev stack, whose ports/creds won't
// match this ephemeral one) when both exist.
function loadEnv(): void {
  const root = path.join(__dirname, '..', '..', '..');
  const envPath = fs.existsSync(path.join(root, '.env.test'))
    ? path.join(root, '.env.test')
    : path.join(root, '.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined)
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no env file — rely on the ambient environment */
  }
}
if (TEST_TARGET === 'local') loadEnv(); // staging never reads env files — secrets come from the environment

// Tolerate a scheme-less base URL (e.g. API_URL=localhost:3010) — fetch() requires a scheme.
const withScheme = (u: string) => (u && !/^https?:\/\//i.test(u) ? `http://${u}` : u);

// Env names match the root .env (DEVICE_GATEWAY_URL / MQTT_SERVER_NAME), with older aliases as fallback.
export const API_URL =
  TEST_TARGET === 'staging'
    ? requireStagingEnv('STAGING_API_URL')
    : withScheme(process.env.API_URL || 'http://localhost:3100');
export const GATEWAY_URL =
  TEST_TARGET === 'staging'
    ? requireStagingEnv('STAGING_GATEWAY_URL')
    : withScheme(
        process.env.DEVICE_GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:3004',
      );
export const MQTT_HOST = process.env.MQTT_SERVER_NAME || process.env.MQTT_HOST || '127.0.0.1';
export const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
// Full broker URL — staging is TLS (mqtts://…:8883); local is plain tcp.
export const MQTT_URL =
  TEST_TARGET === 'staging'
    ? requireStagingEnv('STAGING_MQTT_URL')
    : `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
export const SOCKET_URL =
  TEST_TARGET === 'staging'
    ? requireStagingEnv('STAGING_SOCKET_URL')
    : withScheme(process.env.SOCKET_URL || 'http://localhost:3007');
// Host-reachable AMQP URL for suites that publish events directly (bypassing a producer service).
// The test stack maps RabbitMQ to host port 25672; the container-internal RABBITMQ_URL (…@rabbitmq)
// that services use is unreachable from the host runner, so this deliberately does NOT fall back
// to it — same host-port convention as the queue integration suite.
export const RABBITMQ_URL =
  TEST_TARGET === 'staging'
    ? requireStagingEnv('STAGING_RABBITMQ_URL')
    : process.env.RABBITMQ_TEST_URL ||
      `amqp://${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@localhost:25672`;

// Test credentials. On staging this is ALWAYS the dedicated e2e-bot user (mutating acceptance
// suites must never touch real user data — docs/TESTING.md safety model).
export const TEST_USER =
  TEST_TARGET === 'staging' ? requireStagingEnv('E2E_BOT_USER') : process.env.E2E_USER || 'admin';
export const TEST_PASS =
  TEST_TARGET === 'staging' ? requireStagingEnv('E2E_BOT_PASS') : process.env.E2E_PASS || 'admin';

// The device simulator under test (plain JS lib; required so TS needs no declarations).

export const { SimDevice } = require('../../../tools/device-sim/lib/sim-device');

export async function stackUp(): Promise<boolean> {
  for (const url of [`${API_URL}/health`, `${GATEWAY_URL}/health`]) {
    try {
      const r = await fetch(url);
      if (!r.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// Test wrapper that runs the body only when the stack is reachable, otherwise logs and passes.
export function itStack(name: string, fn: () => Promise<void>, timeout?: number): void {
  it(
    name,
    async () => {
      if (!(await stackUp())) {
        console.warn(`SKIP (stack down): ${name}`);
        return;
      }
      await fn();
    },
    timeout,
  );
}

// Wrapper for infra-disruptive cases (broker restarts, poison messages). Hard safety gate:
// never runs against staging, and must be explicitly opted into locally with TEST_DISRUPTIVE=1
// (they restart containers — you don't want that mid-dev by accident). See docs/TESTING.md.
export function itDisruptive(name: string, fn: () => Promise<void>, timeout?: number): void {
  it(
    name,
    async () => {
      if (TEST_TARGET !== 'local' || process.env.TEST_DISRUPTIVE !== '1') {
        console.warn(`SKIP (disruptive — needs TEST_TARGET=local and TEST_DISRUPTIVE=1): ${name}`);
        return;
      }
      if (!(await stackUp())) {
        console.warn(`SKIP (stack down): ${name}`);
        return;
      }
      await fn();
    },
    timeout,
  );
}

// Standard SimDevice options for the current TEST_TARGET. Suites spread in their specifics:
//   new SimDevice(simOpts({ mac, deviceType: 'ESP32S3_MINI', autoTelemetry: false }))
export function simOpts(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiUrl: API_URL,
    gatewayUrl: GATEWAY_URL,
    mqttUrl: MQTT_URL,
    user: TEST_USER,
    pass: TEST_PASS,
    persist: false, // never touch the on-disk NVS file during tests
    ...extra,
  };
}

export async function login(user = TEST_USER, pass = TEST_PASS): Promise<string> {
  const r = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!r.ok) throw new Error(`login → ${r.status}`);
  const body = await r.json();
  // /auth/login returns { token, refreshToken }; older builds returned a bare JWT string.
  return body && typeof body === 'object' && body.token ? body.token : body;
}

export async function apiGet(pathname: string, token: string): Promise<any> {
  const r = await fetch(`${API_URL}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${pathname} → ${r.status}`);
  return r.json();
}

export async function apiPost(pathname: string, token: string, body: unknown): Promise<any> {
  const r = await fetch(`${API_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${pathname} → ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export async function apiPatch(pathname: string, token: string, body: unknown): Promise<void> {
  const r = await fetch(`${API_URL}${pathname}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${pathname} → ${r.status}: ${await r.text()}`);
}

export async function apiPut(pathname: string, token: string, body: unknown): Promise<any> {
  const r = await fetch(`${API_URL}${pathname}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${pathname} → ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// Non-throwing variant for asserting on rejections — the apiX helpers above throw on !ok, which
// makes "this must be a 400 that says X" awkward to express.
export async function apiRaw(
  method: string,
  pathname: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body — hand it back as text */
  }
  return { status: r.status, body: parsed };
}

export async function apiDelete(pathname: string, token: string): Promise<void> {
  const r = await fetch(`${API_URL}${pathname}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`DELETE ${pathname} → ${r.status}`);
}

export async function poll<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  { timeoutMs = 10000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const start = Date.now();

  while (true) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// A privileged MQTT publisher using the app (EMQX superuser) credentials — lets a test inject
// device commands the way the backend's mqtt-service does. Returns null if creds aren't configured.
export function backendPublisher(): mqtt.MqttClient | null {
  const username = process.env.MQTT_APP_USERNAME;
  const password = process.env.MQTT_APP_PASSWORD;
  if (!username || !password) return null;
  return mqtt.connect(MQTT_URL, {
    username,
    password,
    reconnectPeriod: 0,
  });
}

export function publishCommand(
  pub: mqtt.MqttClient,
  dev: any,
  actionName: string,
  payload: unknown,
): void {
  const topic = `users/${dev.userId}/devices/${dev.deviceId}/${dev.version}/command/${actionName}`;
  pub.publish(topic, JSON.stringify(payload), { qos: 1 });
}
