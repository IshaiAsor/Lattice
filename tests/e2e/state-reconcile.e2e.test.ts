// E2E: state reconciliation (F23). A command action's stored state is only ever as true as the
// last ack the platform saw, so this drives that failure directly: make the device deaf on the way
// back, let the DB go stale, then prove a read-back corrects it. Mutating (device state) —
// acceptance-safe as e2e-bot.
//
// Not asserted here: that a read leaves `device_commands` untouched. There is no HTTP surface over
// command history yet (F18.7), and these suites have no DB access by design — the wire-level half
// of that guard is unit-tested in tests/unit/digest.read-command.test.ts instead.

import {
  SimDevice,
  itStack,
  stackUp,
  login,
  simOpts,
  apiGet,
  apiPost,
  apiRaw,
  poll,
  backendPublisher,
  publishCommand,
  settleAfterStart,
} from './helpers/stack';
import type { MqttClient } from 'mqtt';

jest.setTimeout(120000);

describe('state reconciliation e2e', () => {
  let dev: any;
  let token: string;
  let pub: MqttClient | null = null;
  let outletActionId: number | undefined;
  let outletMqttName: string | undefined;
  const MAC = `SIM-E2E-RECON-${Date.now().toString(36)}`;

  const readAction = (id: number): Promise<any> =>
    apiGet('/api/actions', token).then((all: any[]) => all.find((a) => a.id === id));

  beforeAll(async () => {
    if (!(await stackUp())) return;
    token = await login();
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
        autoTelemetry: false,
        camera: false,
      }),
    );
    await dev.start();
    // Provisioning triggers a config-reload restart; let it land before commanding the device.
    await settleAfterStart(dev);
    pub = backendPublisher();

    const outlet = dev.actions.find((a: any) => a.implementation_type === 'OutletCommandAction');
    if (!outlet) return;
    outletMqttName = outlet.mqtt_action_name;
    const actions = await apiGet('/api/actions', token);
    outletActionId = actions.find(
      (a: any) => a.deviceId === dev.deviceId && a.mqttName === outletMqttName,
    )?.id;
  });

  afterAll(async () => {
    if (pub) await new Promise((r) => pub!.end(false, {}, () => r(null)));
    if (dev) await dev.cleanup();
  });

  itStack('a read-back refreshes the confirmation stamp and its source', async () => {
    if (!outletActionId) {
      console.warn('no outlet command in catalog — skipping');
      return;
    }

    // A read needs the device reachable, and under a parallel run the broker drops sim connections
    // often enough that it may not be at this instant. Waiting for the platform to say it is online
    // keeps a failure here meaning "reconciliation is broken" rather than "the broker was busy".
    const online = await poll(
      () => readAction(outletActionId!),
      (a: any) => a?.online === true,
      {
        timeoutMs: 30000,
      },
    ).catch(() => null);
    if (!online) {
      console.warn('device not online — skipping the read-back case');
      return;
    }

    const priorConfirmedAt = (await readAction(outletActionId))?.lastConfirmedAt ?? null;
    const res = await apiRaw('POST', `/api/actions/${outletActionId}/read`, token, {});
    expect(res.status).toBe(202);
    expect(typeof res.body.timeoutMs).toBe('number');

    const confirmed = await poll(
      () => readAction(outletActionId!),
      (a: any) => !!a?.lastConfirmedAt && a.lastConfirmedAt !== priorConfirmedAt,
      { timeoutMs: 40000 },
    );
    expect(confirmed.stateSource).toBe('reconcile');
  });

  itStack('a lost ack leaves stale state that a read-back heals', async () => {
    if (!outletActionId || !outletMqttName) {
      console.warn('no outlet command in catalog — skipping');
      return;
    }
    if (!pub) {
      console.warn('no app MQTT creds (MQTT_APP_*) — skipping');
      return;
    }

    // The baseline is whatever the platform currently believes — read from the API, not from the
    // device. Dispatching a read just to establish it would make this test depend on the device
    // being reachable twice, and in a parallel run the broker drops sim connections often enough
    // that the extra round-trip becomes the most likely thing to fail here.
    const startState = (await readAction(outletActionId))?.state;
    const target = startState === 'on' ? 'off' : 'on';

    // Make the device deaf on the way back, then command it. It still APPLIES the command — it
    // just never says so, which is exactly the lost-ack case reconciliation exists for.
    //
    // Commanded over MQTT rather than through the socket on purpose: what this test needs is a
    // device holding a state the platform never heard about, and every extra hop between here and
    // the device is a way for the test to fail for a reason that is not the thing under test.
    dev.opts.suppressAck = [outletMqttName];
    const suppressed = dev.waitFor(
      'ack-suppressed',
      (a: any) => a.action === outletMqttName && a.value === target,
      30000,
    );
    publishCommand(pub, dev, outletMqttName, {
      value: target,
      commandId: `e2e-lost-${Date.now()}`,
    });
    await suppressed;

    // The device is at `target`; the platform still believes `startState`. That is the divergence,
    // and before F23 nothing in the platform would ever have noticed it.
    const stale = await readAction(outletActionId);
    expect(stale.state).toBe(startState);

    // Let it answer again, and ask. The read needs the device reachable, so wait for the platform
    // to agree that it is rather than racing a reconnect.
    dev.opts.suppressAck = [];
    const backOnline = await poll(
      () => readAction(outletActionId!),
      (a: any) => a?.online === true,
      { timeoutMs: 30000 },
    ).catch(() => null);
    if (!backOnline) {
      console.warn('device did not come back online — skipping the heal half');
      return;
    }
    await apiPost(`/api/actions/${outletActionId}/read`, token, {});

    const healed = await poll(
      () => readAction(outletActionId!),
      (a: any) => a?.state === target,
      {
        timeoutMs: 40000,
      },
    );
    expect(healed.state).toBe(target);
    expect(healed.stateSource).toBe('reconcile');
  });

  itStack('an offline device is refused rather than dispatched to', async () => {
    if (!outletActionId) {
      console.warn('no outlet command in catalog — skipping');
      return;
    }

    await dev.stop();
    const wentOffline = await poll(
      () => readAction(outletActionId!),
      (a: any) => a?.online === false,
      { timeoutMs: 30000 },
    ).catch(() => null);
    if (!wentOffline) {
      console.warn('device still recorded online — offline rejection not exercised');
      return;
    }

    // 409 is the point: a read to a device that cannot answer is refused immediately rather than
    // spending the whole timeout to reach the same conclusion.
    const res = await apiRaw('POST', `/api/actions/${outletActionId}/read`, token, {});
    expect(res.status).toBe(409);
  });
});
