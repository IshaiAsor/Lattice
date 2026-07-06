// Sanity: platform domain — READ-ONLY (docs/TESTING.md safety model). Safe against any env.
//
// Covers the failure class behind the past "devices silently offline" incident: services
// answering /health while their RabbitMQ consumers are dead. The consumer-count check needs
// the RabbitMQ management API (RABBITMQ_MGMT_URL + RABBITMQ_MGMT_USER/PASS); it logs a skip
// when not configured (e.g. staging, where mgmt isn't exposed outside the cluster).

import * as mqtt from 'mqtt';
import { itStack, API_URL, GATEWAY_URL, MQTT_URL } from '../e2e/helpers/stack';
import { QUEUES } from '../../packages/queue/src/keys';

// Optional extra /health URLs beyond api + gateway (comma-separated), e.g. the full local
// service set or staging ingress routes. api + gateway are always probed.
const EXTRA_HEALTH = (process.env.SANITY_HEALTH_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

describe('sanity: platform', () => {
  itStack('core /health endpoints respond ok', async () => {
    for (const url of [`${API_URL}/health`, `${GATEWAY_URL}/health`, ...EXTRA_HEALTH]) {
      const r = await fetch(url);
      expect(`${url} → ${r.status}`).toBe(`${url} → 200`);
    }
  });

  itStack('every static queue has a live consumer (RabbitMQ mgmt API)', async () => {
    const mgmt = process.env.RABBITMQ_MGMT_URL;
    if (!mgmt) {
      console.warn('SKIP: RABBITMQ_MGMT_URL not set — consumer-count check needs the mgmt API');
      return;
    }
    const user = process.env.RABBITMQ_MGMT_USER || process.env.RABBITMQ_DEFAULT_USER || 'guest';
    const pass = process.env.RABBITMQ_MGMT_PASS || process.env.RABBITMQ_DEFAULT_PASS || 'guest';
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const r = await fetch(`${mgmt.replace(/\/$/, '')}/api/queues`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    expect(r.ok).toBe(true);
    const queues = (await r.json()) as Array<{ name: string; consumers: number }>;
    const byName = new Map(queues.map((q) => [q.name, q.consumers]));

    // The DLQ legitimately has no consumer; every other static queue must have one —
    // a bound queue with zero consumers is the silent-offline failure mode.
    const dead: string[] = [];
    for (const name of Object.values(QUEUES)) {
      if (name === QUEUES.DLQ) continue;
      if (!byName.has(name)) continue; // queue not asserted in this env (optional service)
      if ((byName.get(name) ?? 0) < 1) dead.push(name);
    }
    expect(dead).toEqual([]);
  });

  itStack('MQTT broker accepts an app-credential connection', async () => {
    const username = process.env.MQTT_APP_USERNAME;
    const password = process.env.MQTT_APP_PASSWORD;
    if (!username || !password) {
      console.warn('SKIP: MQTT_APP_USERNAME/MQTT_APP_PASSWORD not set');
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const client = mqtt.connect(MQTT_URL, {
        username,
        password,
        reconnectPeriod: 0,
        connectTimeout: 8000,
      });
      const done = (err?: Error) => {
        client.end(true, {}, () => (err ? reject(err) : resolve()));
      };
      client.on('connect', () => done());
      client.on('error', (e) => done(e));
    });
  });
});
