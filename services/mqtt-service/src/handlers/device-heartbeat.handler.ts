import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { DeviceHeartbeatPayload } from '@lattice/queue';
import type { MqttHandler } from './handler.interface';
import { createLogger } from '@lattice/logger';

const log = createLogger('mqtt-service:device-heartbeat');

// Devices ping .../heartbeat on an interval (independent of telemetry). We forward it as
// DEVICE_HEARTBEAT so digest can refresh a short-TTL last-seen key. Body is a small JSON of
// diagnostics ({uptimeMs,freeHeap,rssi,version}); a malformed body still counts as liveness,
// so we forward the ping with metrics omitted rather than dead-lettering it.
export function deviceHeartbeatHandler(ch: Channel): MqttHandler {
  return {
    pattern: 'users/+/devices/+/+/heartbeat',
    handle: async ({ parsed, payload }) => {
      let metrics: { uptimeMs?: number; freeHeap?: number; rssi?: number } = {};
      try {
        const body = JSON.parse(payload.toString()) as Record<string, unknown>;
        metrics = {
          uptimeMs: typeof body['uptimeMs'] === 'number' ? body['uptimeMs'] : undefined,
          freeHeap: typeof body['freeHeap'] === 'number' ? body['freeHeap'] : undefined,
          rssi: typeof body['rssi'] === 'number' ? body['rssi'] : undefined,
        };
      } catch {
        log.warn({ topic: parsed }, 'heartbeat body not valid JSON — forwarding without metrics');
      }

      const msg: DeviceHeartbeatPayload = {
        userId: parsed.userId,
        deviceId: parsed.deviceId,
        version: parsed.version,
        timestamp: new Date().toISOString(),
        ...metrics,
      };
      publish(ch, RK.DEVICE_HEARTBEAT, msg);
      log.debug({ topic: parsed, msg }, 'device heartbeat received and forwarded');
    },
  };
}
