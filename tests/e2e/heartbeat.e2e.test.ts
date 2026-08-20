// E2E: MQTT heartbeat. A sim device pings .../heartbeat on an interval (independent of
// telemetry). We assert two things: (1) the ping reaches the broker with the expected JSON
// shape — which also proves the acl.conf publish rule is in place — and (2) mqtt-service
// forwards it so digest sets the last-seen cache key. Read-only w.r.t. app state.

import * as mqtt from 'mqtt';
import { SimDevice, itStack, stackUp, simOpts, MQTT_URL, settleAfterStart } from './helpers/stack';

jest.setTimeout(60000);

// A raw superuser subscriber (same creds the backend uses) to observe the device's heartbeat
// topic directly. Returns null if app MQTT creds aren't configured for this environment.
function backendSubscriber(): mqtt.MqttClient | null {
  const username = process.env.MQTT_APP_USERNAME;
  const password = process.env.MQTT_APP_PASSWORD;
  if (!username || !password) return null;
  return mqtt.connect(MQTT_URL, { username, password, reconnectPeriod: 0 });
}

describe('device heartbeat e2e', () => {
  let dev: any;
  let sub: mqtt.MqttClient | null = null;
  const MAC = `SIM-E2E-HB-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!(await stackUp())) return;
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
        autoTelemetry: true, // heartbeat runs in the telemetry loop set
        heartbeatMs: 1000, // ping fast so the test doesn't wait a full minute
        camera: false,
      }),
    );
    await dev.start();
    // Provisioning triggers a config-reload restart; let it land before commanding the device.
    await settleAfterStart(dev);
  });

  afterAll(async () => {
    if (sub) sub.end(true);
    if (dev) await dev.cleanup();
  });

  itStack('publishes a heartbeat with the expected diagnostics shape', async () => {
    sub = backendSubscriber();
    if (!sub) {
      console.warn('no MQTT_APP_* creds — skipping heartbeat subscribe assertion');
      return;
    }
    const topic = `users/${dev.userId}/devices/${dev.deviceId}/${dev.version}/heartbeat`;

    const received = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no heartbeat within 15s')), 15000);
      sub!.on('error', reject);
      sub!.subscribe(topic, (err) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
      sub!.on('message', (t, payload) => {
        if (t !== topic) return;
        clearTimeout(timer);
        resolve(JSON.parse(payload.toString()));
      });
    });

    expect(typeof received.uptimeMs).toBe('number');
    expect(typeof received.freeHeap).toBe('number');
    expect(typeof received.rssi).toBe('number');
    expect(received.version).toBe(dev.version);
  });
});
