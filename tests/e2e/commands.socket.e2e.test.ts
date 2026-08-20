// E2E: commands domain, UI path — a Socket.IO client (what the backoffice does) sends
// action_state_update and the device receives the command; digest echoes the state update
// back to the user's room. Complements device-sim.e2e.test.ts, which drives the raw MQTT
// path. Mutating (device state) — acceptance-safe as e2e-bot.

import { io, Socket } from 'socket.io-client';
import {
  SimDevice,
  itStack,
  stackUp,
  login,
  simOpts,
  SOCKET_URL,
  apiGet,
  settleAfterStart,
} from './helpers/stack';

jest.setTimeout(60000);

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_URL, { auth: { token }, transports: ['websocket'], timeout: 8000 });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

describe('commands via socket e2e', () => {
  let dev: any;
  let token: string;
  let socket: Socket | null = null;
  let outlet: any;
  let outletActionId: number | undefined;
  const MAC = `SIM-E2E-SOCK-${Date.now().toString(36)}`;

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

    outlet = dev.actions.find((a: any) => a.implementation_type === 'OutletCommandAction');
    if (outlet) {
      const actions = await apiGet('/api/actions', token);
      outletActionId = actions.find(
        (a: any) => a.deviceId === dev.deviceId && a.mqttName === outlet.mqtt_action_name,
      )?.id;
    }
  });

  afterAll(async () => {
    if (socket) socket.disconnect();
    if (dev) await dev.cleanup();
  });

  itStack('rejects a connection without a token', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const s = io(SOCKET_URL, { transports: ['websocket'], timeout: 5000 });
        s.on('connect', () => {
          s.disconnect();
          resolve('connected');
        });
        s.on('connect_error', (err) => {
          s.disconnect();
          reject(err);
        });
      }),
    ).rejects.toThrow(/Authentication/i);
  });

  itStack('action_state_update reaches the device and the state echo returns', async () => {
    if (!outletActionId) {
      console.warn('no outlet command in catalog — skipping');
      return;
    }
    socket = await connectSocket(token);

    // Collect state echoes for our action (digest emits to the user room after its DB write).
    const echoes: any[] = [];
    socket.on('action_state_update', (payload: any) => echoes.push(payload));

    const commandP = dev.waitFor(
      'command',
      (c: any) => c.action === outlet.mqtt_action_name && c.value === 'on',
      15000,
    );
    socket.emit('action_state_update', { actionId: outletActionId, state: 'on' });

    const cmd = await commandP;
    expect(cmd.valid).toBe(true);

    // The echo is best-effort UI plumbing but part of the contract — poll briefly for it.
    const deadline = Date.now() + 10000;
    while (echoes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(echoes.length).toBeGreaterThan(0);
  });
});
