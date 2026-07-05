// Shared helpers for end-to-end tests that drive the running stack via the SimDevice fixture.
//
// These suites need the local stack (docker compose + the backend services). When it's down they
// SKIP (not fail) — see `itStack` — so `npm test` is safe on a cold checkout.

import * as fs from 'fs';
import * as path from 'path';
import * as mqtt from 'mqtt';

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
loadEnv();

// Tolerate a scheme-less base URL (e.g. API_URL=localhost:3010) — fetch() requires a scheme.
const withScheme = (u: string) => (u && !/^https?:\/\//i.test(u) ? `http://${u}` : u);

// Env names match the root .env (DEVICE_GATEWAY_URL / MQTT_SERVER_NAME), with older aliases as fallback.
export const API_URL = withScheme(process.env.API_URL || 'http://localhost:3100');
export const GATEWAY_URL = withScheme(
  process.env.DEVICE_GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:3004',
);
export const MQTT_HOST = process.env.MQTT_SERVER_NAME || process.env.MQTT_HOST || '127.0.0.1';
export const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);

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

export async function login(user = 'admin', pass = 'admin'): Promise<string> {
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
  return mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
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
