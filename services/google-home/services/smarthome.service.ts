import { db } from '@lattice/prisma-client';
import { publish, RK } from '@lattice/queue';
import { valkeyService } from './valkey.service';
import { createLogger } from '@lattice/logger';

const log = createLogger('google-home:smarthome');

// ─── Device ID helpers ────────────────────────────────────────────────────────

const toGoogleId   = (userDeviceId: number) => `device_${userDeviceId}`;
const fromGoogleId = (id: string): number   => parseInt(id.replace('device_', ''));

// ─── State mapping ────────────────────────────────────────────────────────────

function stateFromActions(
  actions: { state: string | null; action_def: { capability: string } }[],
  online: boolean,
): Record<string, unknown> {
  const state: Record<string, unknown> = { online };

  for (const a of actions) {
    if (a.state === null) continue;
    const val = a.state;
    const cap = a.action_def.capability;

    switch (cap) {
      case 'light_dimmer':
        state.on         = val === 'on' || val === '1';
        state.brightness = parseInt(val) || (state.on ? 100 : 0);
        break;
      case 'outlet':
      case 'fan':
      case 'pump':
      case 'one_directional_motor':
        state.on = val === 'on' || val === '1';
        break;
      case 'air_temperature':  state.thermostatTemperatureAmbient = parseFloat(val); break;
      case 'humidity':         state.humidityAmbientPercent       = parseFloat(val); break;
      case 'ph_level':         state.currentPhLevel               = parseFloat(val); break;
      case 'tds_level':        state.currentTdsLevel              = parseFloat(val); break;
      case 'water_level':      state.waterLevelPercent            = parseFloat(val); break;
      case 'co2_level':        state.co2Ppm                       = parseFloat(val); break;
    }
  }

  return state;
}

// ─── SYNC ─────────────────────────────────────────────────────────────────────

export async function handleSync(userId: number): Promise<{ agentUserId: string; devices: unknown[] }> {
  // Load everything in one pass — devices → actions → defs
  const devices = await db.userDevice.findMany({
    where: { user_id: userId },
    include: {
      device_model: true,
      actions: {
        include: { action_def: true },
      },
    },
  });

  // Pre-load all Google action types + traits once (small tables, cheap)
  const [allActionTypes, allTraits] = await Promise.all([
    db.googleActionType.findMany(),
    db.googleTrait.findMany(),
  ]);
  const typeMap  = new Map(allActionTypes.map((t) => [t.id, t.key]));
  const traitMap = new Map(allTraits.map((t) => [t.id, t.key]));

  // Pre-load all UserActionDefTrait rows for this user's defs in one query
  const defIds = [...new Set(devices.flatMap((d) => d.actions.map((a) => a.action_def.id)))];
  const defTraits = defIds.length
    ? await db.userActionDefTrait.findMany({ where: { user_action_def_id: { in: defIds } } })
    : [];
  const traitsByDef = new Map<number, number[]>();
  for (const dt of defTraits) {
    const arr = traitsByDef.get(dt.user_action_def_id) ?? [];
    arr.push(dt.google_trait_id);
    traitsByDef.set(dt.user_action_def_id, arr);
  }

  const googleDevices = devices.map((device) => {
    let primaryType = 'action.devices.types.SWITCH';
    const traitSet  = new Set<string>();

    for (const action of device.actions) {
      const def = action.action_def;
      const t   = typeMap.get(def.google_action_type_id);
      if (t) primaryType = t;

      for (const traitId of traitsByDef.get(def.id) ?? []) {
        const traitKey = traitMap.get(traitId);
        if (traitKey) traitSet.add(traitKey);
      }
    }

    // Ensure at minimum OnOff is present so Google can toggle the device
    if (!traitSet.size) traitSet.add('action.devices.traits.OnOff');

    return {
      id:     toGoogleId(device.id),
      type:   primaryType,
      traits: [...traitSet],
      name:   { name: device.name },
      willReportState: true,
      deviceInfo: {
        manufacturer: 'Lattice',
        model:        device.device_model.model_key ?? 'Unknown',
      },
      attributes: {},
    };
  });

  log.info({ userId, deviceCount: googleDevices.length }, 'SYNC');
  return { agentUserId: String(userId), devices: googleDevices };
}

// ─── QUERY ────────────────────────────────────────────────────────────────────

export async function handleQuery(
  userId: number,
  deviceIds: string[],
): Promise<Record<string, unknown>> {
  const userDeviceIds = deviceIds.map(fromGoogleId);

  const actions = await db.userAction.findMany({
    where: { user_device_id: { in: userDeviceIds }, user_device: { user_id: userId } },
    include: { action_def: true },
  });

  const byDevice = new Map<number, typeof actions>();
  for (const a of actions) {
    const arr = byDevice.get(a.user_device_id) ?? [];
    arr.push(a);
    byDevice.set(a.user_device_id, arr);
  }

  const states: Record<string, unknown> = {};

  for (const userDeviceId of userDeviceIds) {
    const deviceActions = byDevice.get(userDeviceId) ?? [];

    // Fetch fresh states from Valkey
    const enriched = await Promise.all(deviceActions.map(async (a) => ({
      state:      (await valkeyService.getActionState(a.id)) ?? a.state,
      action_def: a.action_def,
    })));

    const online = await valkeyService.isDeviceOnline(userDeviceId);
    states[toGoogleId(userDeviceId)] = stateFromActions(enriched, online);
  }

  log.debug({ userId, deviceCount: deviceIds.length }, 'QUERY');
  return states;
}

// ─── EXECUTE ──────────────────────────────────────────────────────────────────

type ExecCommand = {
  devices:   { id: string }[];
  execution: { command: string; params: Record<string, unknown> }[];
};

type CommandResult = { ids: string[]; status: string };

function commandToState(command: string, params: Record<string, unknown>): { mqttType: string; mqttName: string; value: string } | null {
  switch (command) {
    case 'action.devices.commands.OnOff':
      return { mqttType: 'command', mqttName: 'set_state', value: params.on ? 'on' : 'off' };
    case 'action.devices.commands.BrightnessAbsolute':
      return { mqttType: 'command', mqttName: 'brightness', value: String(params.brightness) };
    case 'action.devices.commands.FanSpeed':
      return { mqttType: 'command', mqttName: 'fan_speed', value: String(params.fanSpeed) };
    case 'action.devices.commands.ThermostatTemperatureSetpoint':
      return { mqttType: 'command', mqttName: 'temperature_set', value: String(params.thermostatTemperatureSetpoint) };
    default:
      return null;
  }
}

export async function handleExecute(userId: number, commands: ExecCommand[]): Promise<CommandResult[]> {
  const results: CommandResult[] = [];

  for (const cmd of commands) {
    for (const exec of cmd.execution) {
      const resolved = commandToState(exec.command, exec.params ?? {});
      if (!resolved) {
        results.push({ ids: cmd.devices.map((d) => d.id), status: 'ERROR' });
        continue;
      }

      const ids = cmd.devices.map((d) => d.id);
      for (const device of cmd.devices) {
        await publish(RK.actionDispatch(userId), {
          userId,
          userDeviceId: fromGoogleId(device.id),
          mqttType:     resolved.mqttType,
          mqttName:     resolved.mqttName,
          value:        resolved.value,
        });
      }

      results.push({ ids, status: 'PENDING' });
      log.info({ userId, command: exec.command, deviceCount: ids.length }, 'EXECUTE dispatched');
    }
  }

  return results;
}

// ─── Group EXECUTE ────────────────────────────────────────────────────────────
// Allows controlling all devices that share a capability (e.g. "all lights").

export async function handleGroupExecute(
  userId: number,
  capability: string,
  command: string,
  params: Record<string, unknown>,
): Promise<CommandResult> {
  const resolved = commandToState(command, params);
  if (!resolved) return { ids: [], status: 'ERROR' };

  const actions = await db.userAction.findMany({
    where: { user_device: { user_id: userId }, action_def: { capability } },
    include: { user_device: true },
  });

  const ids: string[] = [];
  for (const a of actions) {
    await publish(RK.actionDispatch(userId), {
      userId,
      userDeviceId: a.user_device_id,
      mqttType:     resolved.mqttType,
      mqttName:     resolved.mqttName,
      value:        resolved.value,
    });
    ids.push(toGoogleId(a.user_device_id));
  }

  log.info({ userId, capability, command, deviceCount: ids.length }, 'group EXECUTE dispatched');
  return { ids: [...new Set(ids)], status: 'PENDING' };
}
