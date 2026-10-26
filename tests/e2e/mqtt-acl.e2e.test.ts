// E2E: the broker's device credential boundary (F25.7, docs/plans/F25.7-EMQX-ACL-AUDIT.md §8).
// Every row asserts what a device credential is REFUSED as well as what it is allowed — a
// boundary nobody tries to cross always looks intact. Rows are named after the plan's matrix.
//
// The devices are provisioned through the real flow but never `start()`ed: the sim opens no MQTT
// session of its own (no takeover, no activation reboot), and each test drives a raw MQTT v5
// client with the device's real token. v5 is what makes refusals observable: a refused SUBSCRIBE
// or QoS 1 PUBLISH comes back with reason code 0x87 instead of being dropped silently.
//
// U2/K2 are synthetic ids for now: the ACL refuses on the placeholder values, whether or not the
// row exists. The Phase 1 rows (C2–C4, C7–C10) need a real second user and land with it.

import * as mqtt from 'mqtt';
import { SimDevice, itStack, stackUp, simOpts, MQTT_URL, TEST_TARGET } from './helpers/stack';

jest.setTimeout(60000);

const NOT_AUTHORIZED = 0x87;
// A claim mismatch (wrong `purpose`) is refused 134 "bad username or password"; a bad signature
// 135 "not authorized". Either is a refusal.
const CONNECT_REFUSED = [0x86, 0x87];

// Locally the public 8883 listener is published on 18883 with a self-signed cert; the connect
// rows run against both listeners so a per-listener auth chain can't silently diverge.
const LISTENERS: { name: string; url: string }[] =
  TEST_TARGET === 'local'
    ? [
        { name: 'tcp', url: MQTT_URL },
        {
          name: 'tls',
          url: `mqtts://${process.env.MQTT_SERVER_NAME || '127.0.0.1'}:${process.env.MQTT_TLS_TEST_PORT || '18883'}`,
        },
      ]
    : [{ name: 'broker', url: MQTT_URL }];

type ConnectResult = { client: mqtt.MqttClient } | { refused: number | string };

function connect(
  url: string,
  username: string,
  clientId: string,
  password: string,
): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const client = mqtt.connect(url, {
      protocolVersion: 5,
      username,
      clientId,
      password,
      reconnectPeriod: 0,
      connectTimeout: 8000,
      clean: true,
      rejectUnauthorized: TEST_TARGET !== 'local',
    });
    client.once('connect', () => resolve({ client }));
    client.once('error', (err) => {
      client.end(true);
      resolve({ refused: (err as Error & { code?: number | string }).code ?? err.message });
    });
  });
}

async function connectOk(url: string, username: string, clientId: string, password: string) {
  const r = await connect(url, username, clientId, password);
  if (!('client' in r)) throw new Error(`expected CONNECT accepted, got refused ${r.refused}`);
  return r.client;
}

// One SUBSCRIBE per filter → its SUBACK reason code. On a refusal mqtt.js (5.15) hands back an
// error plus a `granted` array that echoes the REQUESTED qos, so `granted` reports a refused
// subscription as granted; the broker's real code is only on the error's SUBACK packet.
async function subscribeCodes(client: mqtt.MqttClient, filters: string[]): Promise<number[]> {
  const codes: number[] = [];
  for (const filter of filters) {
    codes.push(
      await new Promise<number>((resolve) => {
        client.subscribe(filter, { qos: 1 }, (err, granted) => {
          if (err) {
            const suback = (err as Error & { packet?: { granted?: number[] } }).packet;
            return resolve(suback?.granted?.[0] ?? -1);
          }
          resolve(granted?.[0]?.qos ?? -1);
        });
      }),
    );
  }
  return codes;
}

// QoS 1 publish → resolves the PUBACK reason code (0 = accepted).
function publishCode(
  client: mqtt.MqttClient,
  topic: string,
  payload: string,
  retain = false,
): Promise<number> {
  return new Promise((resolve) => {
    client.publish(topic, payload, { qos: 1, retain }, (err) => {
      resolve(err ? Number((err as Error & { code?: number }).code ?? -1) : 0);
    });
  });
}

describe('MQTT ACL e2e (F25.7)', () => {
  // D1 = K1 of U1, D3 = K3 of U1 — both real. U2/K2 synthetic (see header).
  let d1: any;
  let d3: any;
  let u1 = '';
  let k1 = '';
  let k3 = '';
  let u2 = '';
  let k2 = '';
  let ver = '';
  let observer: mqtt.MqttClient | null = null;
  const seen: { topic: string; payload: string }[] = [];
  const clients: mqtt.MqttClient[] = [];
  const stamp = Date.now().toString(36);

  const base = (u: string, k: string) => `users/${u}/devices/${k}/${ver}`;
  const asD1 = async (url = MQTT_URL) => {
    const c = await connectOk(url, u1, k1, d1.mqttToken);
    clients.push(c);
    return c;
  };
  const sawMarker = (marker: string, count = 1) =>
    seen.filter((m) => m.payload.includes(marker)).length >= count;
  const waitForMarker = async (marker: string, count = 1, timeoutMs = 5000) => {
    const start = Date.now();
    while (!sawMarker(marker, count)) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  };

  beforeAll(async () => {
    if (!(await stackUp())) return;
    const provisioned = async (suffix: string) => {
      const dev = new SimDevice(
        simOpts({
          mac: `SIM-E2E-ACL-${suffix}-${stamp}`,
          deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
          activateAll: false,
          autoTelemetry: false,
          camera: false,
        }),
      );
      await dev.login();
      await dev.loadCatalog();
      await dev.provision();
      return dev;
    };
    d1 = await provisioned('D1');
    d3 = await provisioned('D3');
    u1 = String(d1.userId);
    k1 = String(d1.deviceId);
    k3 = String(d3.deviceId);
    u2 = String(Number(u1) + 100000);
    k2 = String(Number(k1) + 100000);
    ver = d1.version;

    const su = process.env.MQTT_APP_USERNAME;
    const sp = process.env.MQTT_APP_PASSWORD;
    if (su && sp) {
      observer = await connectOk(MQTT_URL, su, `e2e-acl-observer-${stamp}`, sp);
      observer.on('message', (topic, payload) => seen.push({ topic, payload: payload.toString() }));
      await subscribeCodes(observer, ['users/#']);
    }
  });

  afterAll(async () => {
    for (const c of clients) c.end(true);
    if (observer) observer.end(true);
    // Delete the devices BEFORE clearing P1's retained status: digest reads any status other
    // than `online` as offline, and a device_offline notification for a live row would race
    // other suites' inbox assertions. A deleted device resolves to nothing, so no notification.
    if (d1) await d1.cleanup();
    if (d3) await d3.cleanup();
    if (d1 && ver) {
      const c = await connect(MQTT_URL, u1, k1, d1.mqttToken);
      if ('client' in c) {
        await publishCode(c.client, `${base(u1, k1)}/status`, '', true);
        c.client.end(true);
      }
    }
  });

  // ── CONNECT ──────────────────────────────────────────────────────────────

  for (const l of LISTENERS) {
    itStack(`C1 [${l.name}] a device token connects as its own user/device`, async () => {
      const c = await asD1(l.url);
      expect(c.connected).toBe(true);
    });

    itStack(
      `C5 [${l.name}] a login (app_usage) token is refused as a device credential`,
      async () => {
        const r = await connect(l.url, u1, k1, d1.appToken);
        expect(r).toHaveProperty('refused');
        expect(CONNECT_REFUSED).toContain((r as { refused: number }).refused);
      },
    );

    itStack(`C6 [${l.name}] a device refresh token is refused as a device credential`, async () => {
      const r = await connect(l.url, u1, k1, d1.refreshToken);
      expect(r).toHaveProperty('refused');
      expect(CONNECT_REFUSED).toContain((r as { refused: number }).refused);
    });
  }

  // ── SUBSCRIBE ────────────────────────────────────────────────────────────

  itStack('S1 a device may subscribe to its own command topic', async () => {
    const c = await asD1();
    expect(await subscribeCodes(c, [`users/${u1}/devices/${k1}/+/command/#`])).toEqual([1]);
  });

  itStack("S2 a device may not subscribe to a sibling device's commands", async () => {
    const c = await asD1();
    expect(await subscribeCodes(c, [`users/${u1}/devices/${k3}/+/command/#`])).toEqual([
      NOT_AUTHORIZED,
    ]);
  });

  itStack("S3 a device may not wildcard over its user's devices", async () => {
    const c = await asD1();
    expect(await subscribeCodes(c, [`users/${u1}/devices/+/+/command/#`])).toEqual([
      NOT_AUTHORIZED,
    ]);
  });

  itStack("S4 a device may not wildcard over every user's telemetry", async () => {
    const c = await asD1();
    expect(await subscribeCodes(c, ['users/+/devices/+/+/telemetry/#'])).toEqual([NOT_AUTHORIZED]);
  });

  itStack(
    'S5 a device may not subscribe to #, $SYS, or a shared group on another device',
    async () => {
      const c = await asD1();
      expect(
        await subscribeCodes(c, ['#', '$SYS/#', `$share/g/users/${u2}/devices/${k2}/+/command/#`]),
      ).toEqual([NOT_AUTHORIZED, NOT_AUTHORIZED, NOT_AUTHORIZED]);
    },
  );

  // ── PUBLISH ──────────────────────────────────────────────────────────────

  itStack('P1 a device may publish its own status, telemetry, ack and heartbeat', async () => {
    const c = await asD1();
    const marker = `p1-${stamp}`;
    const own = base(u1, k1);
    // Exactly `online`: digest reads any other status payload as offline (and notifies), so the
    // status row is matched by topic below rather than by marker.
    expect(await publishCode(c, `${own}/status`, 'online', true)).toBe(0);
    expect(
      await publishCode(c, `${own}/telemetry/e2e_acl_probe`, JSON.stringify({ value: 1, marker })),
    ).toBe(0);
    expect(
      await publishCode(c, `${own}/ack/e2e_acl_probe`, JSON.stringify({ status: 'ok', marker })),
    ).toBe(0);
    expect(await publishCode(c, `${own}/heartbeat`, JSON.stringify({ uptimeMs: 1, marker }))).toBe(
      0,
    );
    if (!observer) return console.warn('no MQTT_APP_* creds — skipping delivery assertion');
    expect(await waitForMarker(marker, 3)).toBe(true);
    const delivered = new Set(
      seen
        .filter((m) => m.payload.includes(marker) || m.topic === `${own}/status`)
        .map((m) => m.topic),
    );
    expect([...delivered].sort()).toEqual(
      [
        `${own}/ack/e2e_acl_probe`,
        `${own}/heartbeat`,
        `${own}/status`,
        `${own}/telemetry/e2e_acl_probe`,
      ].sort(),
    );
  });

  // A refused publish must also not reach anyone: after it, a permitted publish on the same
  // connection is the positive control (the broker handles one client's publishes in order).
  async function expectRefusedPublish(c: mqtt.MqttClient, topic: string) {
    const denied = `denied-${topic}-${stamp}`;
    expect(await publishCode(c, topic, JSON.stringify({ marker: denied }))).toBe(NOT_AUTHORIZED);
    if (!observer) return;
    const control = `control-${topic}-${stamp}`;
    expect(
      await publishCode(c, `${base(u1, k1)}/heartbeat`, JSON.stringify({ marker: control })),
    ).toBe(0);
    expect(await waitForMarker(control)).toBe(true);
    expect(sawMarker(denied)).toBe(false);
  }

  itStack('P2 a device may not publish onto its own command topic', async () => {
    await expectRefusedPublish(await asD1(), `${base(u1, k1)}/command/e2e_acl_probe`);
  });

  itStack("P3 a device may not publish a sibling's or another user's telemetry", async () => {
    const c = await asD1();
    await expectRefusedPublish(c, `${base(u1, k3)}/telemetry/e2e_acl_probe`);
    await expectRefusedPublish(c, `${base(u2, k2)}/telemetry/e2e_acl_probe`);
  });
});
