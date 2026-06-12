import { deviceCache, DeviceMapEntry, ActionMapEntry } from '../dal/device.cache';
import { checkEmergency } from './emergency.service';
import { socketEmitter } from './socket.emitter.service';
import { publish, RK } from '@lattice/queue';
import { getTraceId, injectTraceHeaders } from '@lattice/otel';
import { createLogger } from '@lattice/logger';

const log = createLogger('device-gateway:action-hub');

/**
 * ActionHub hot path — called for every telemetry MQTT message.
 *
 * Steps (all must stay sub-10ms for the emergency check window):
 *  1. Resolve device + action from Valkey cache (DB fallback on miss)
 *  2. Write new state to Valkey
 *  3. Emergency check (sync, Valkey-cached rules, no DB)
 *  4. Emit socket event via redis-emitter → api → Angular
 *  5. Publish telemetry.arrived to RabbitMQ (async — all DB writes happen there)
 */
export async function processTelemetry(
  macId: string,
  userId: number,
  actionKey: string,
  value: string,
): Promise<void> {
  const traceId = getTraceId();

  // 1. Resolve device
  const deviceEntry: DeviceMapEntry | null = await deviceCache.resolveDevice(macId);
  if (!deviceEntry) {
    log.warn({ macId, actionKey }, 'Unknown device — ignoring telemetry');
    return;
  }
  const { userDeviceId } = deviceEntry;

  // Sanity check: userId from topic must match the device owner
  if (deviceEntry.userId !== userId) {
    log.warn({ macId, topicUserId: userId, ownerUserId: deviceEntry.userId }, 'userId mismatch — ignoring');
    return;
  }

  // 1b. Resolve action
  const actionEntry: ActionMapEntry | null = await deviceCache.resolveAction(userDeviceId, actionKey);
  if (!actionEntry) {
    log.debug({ macId, userDeviceId, actionKey }, 'Unknown action key — ignoring telemetry');
    return;
  }
  const { userActionId, userActionDefId, capability } = actionEntry;
  const isCameraAction = capability === 'camera' || actionKey === 'camera';

  // 2. Write state to Valkey (non-blocking — fire the promise, await inside is fine here)
  await deviceCache.setState(userActionId, value);
  await deviceCache.markOnline(userDeviceId);

  // 3. Emergency check (awaited — must happen before socket emit for ordering guarantees)
  await checkEmergency(userId, userActionId, capability, value, traceId);

  // 4. Socket emit → Angular
  socketEmitter.emitActionStateUpdate(userId, userActionId, value);

  // 5. Publish to RabbitMQ for async DB write + rules evaluation
  publish(RK.telemetryArrived(userId), {
    userId,
    userDeviceId,
    userActionId,
    userActionDefId,
    capability,
    value,
    isCameraAction,
    timestamp: new Date().toISOString(),
    traceId,
  }, injectTraceHeaders()).catch((err) =>
    log.error(err, 'Failed to publish telemetry.arrived'),
  );
}

/**
 * Handle device status (online / offline heartbeat from MQTT `status` topic).
 */
export async function processStatus(macId: string, userId: number, payload: string): Promise<void> {
  const deviceEntry = await deviceCache.resolveDevice(macId);
  if (!deviceEntry) return;
  const { userDeviceId } = deviceEntry;

  const online = payload === 'online' || payload === '1';

  if (online) await deviceCache.markOnline(userDeviceId);

  // Emit socket event → Angular
  socketEmitter.emitDeviceStatusChange(userId, userDeviceId, online);

  // Publish device state change for ingest-worker + google-home-service
  publish(RK.deviceStateChanged(userId), {
    userId,
    userDeviceId,
    userActionId: 0,   // status event — no specific action
    value: online ? 'online' : 'offline',
  }).catch((err) => log.error(err, 'Failed to publish device.state.changed'));
}
