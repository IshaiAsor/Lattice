import { smarthome } from 'actions-on-google';
import { db } from '@lattice/prisma-client';
import { valkeyService } from './valkey.service';
import { createLogger } from '@lattice/logger';
import fs from 'fs';
import config from '../config/env.config';

const log = createLogger('google-home:homegraph');

let _app: ReturnType<typeof smarthome> | null = null;

function getApp(): ReturnType<typeof smarthome> {
  if (_app) return _app;
  if (!config.google.homegraphKeyFile || !fs.existsSync(config.google.homegraphKeyFile)) {
    log.warn('GOOGLE_HOMEGRAPH_KEY_FILE not set or not found — reportState disabled');
    // Return a no-op app so callers don't crash
    _app = smarthome();
    return _app;
  }
  const jwt = JSON.parse(fs.readFileSync(config.google.homegraphKeyFile, 'utf8'));
  _app = smarthome({ jwt });
  return _app;
}

export function getSmarthomeApp(): ReturnType<typeof smarthome> {
  return getApp();
}

export async function reportState(
  userId: number,
  userDeviceId: number,
  userActionId: number,
  value: string,
): Promise<void> {
  const app = getApp();
  if (!config.google.homegraphKeyFile) return;

  const googleDeviceId = `device_${userDeviceId}`;

  // Build a partial state update for just this action
  const action = await db.userAction.findUnique({
    where: { id: userActionId },
    include: { action_def: true },
  });
  if (!action) return;

  const cap = action.action_def.capability;
  const states: Record<string, unknown> = {};

  switch (cap) {
    case 'light_dimmer':
    case 'outlet':
    case 'fan':
    case 'pump':
      states.on = value === 'on' || value === '1';
      if (cap === 'light_dimmer') states.brightness = parseInt(value) || (states.on ? 100 : 0);
      break;
    case 'air_temperature':  states.thermostatTemperatureAmbient = parseFloat(value); break;
    case 'humidity':         states.humidityAmbientPercent       = parseFloat(value); break;
    default:                 states.currentValue                 = value;
  }

  const online = await valkeyService.isDeviceOnline(userDeviceId);
  states.online = online;

  try {
    await (app as any).reportState({
      agentUserId: String(userId),
      requestId:   crypto.randomUUID(),
      payload: { devices: { states: { [googleDeviceId]: states } } },
    });
    log.debug({ userId, userDeviceId, cap, value }, 'HomeGraph reportState sent');
  } catch (err) {
    log.error(err, 'HomeGraph reportState failed');
  }
}
