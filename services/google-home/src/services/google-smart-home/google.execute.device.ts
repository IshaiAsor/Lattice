import { Channel } from 'amqplib';
import { SmartHomeV1ExecuteRequestExecution } from 'actions-on-google';
import { validateValue } from '@lattice/capability-validation';
import { createLogger } from '@lattice/logger';
import { deviceActionsService, DeviceActionView } from '../device.actions.service';
import { dispatchAction } from '../command.dispatch';

const log = createLogger('google-home:execute');

type ValueMapper = (params: any) => string | undefined;

const IMPLEMENTATION_COMMAND_MAP: Record<string, Record<string, ValueMapper>> = {
  OutletAction: {
    'action.devices.commands.OnOff':      p => p.on ? 'on' : 'off',
    'action.devices.commands.LockUnlock': p => p.lock ? 'on' : 'off',
    'action.devices.commands.StartStop':  p => p.start ? 'on' : 'off',
    'action.devices.commands.OpenClose':  p => p.openPercent > 0 ? 'on' : 'off',
    'action.devices.commands.ArmDisarm':  p => p.arm ? 'arm' : 'disarm',
  },
  LightDimmerAction: {
    'action.devices.commands.OnOff':              p => p.on ? 'on' : 'off',
    'action.devices.commands.BrightnessAbsolute': p => String(p.brightness),
  },
  OneDirectionalMotorAction: {
    'action.devices.commands.OnOff':       p => p.on ? 'on' : 'off',
    'action.devices.commands.SetFanSpeed': p => p.fanSpeedPercent !== undefined
      ? String(p.fanSpeedPercent)
      : p.fanSpeed === 'high_speed' ? '100' : '50',
    'action.devices.commands.StartStop':   p => p.start ? 'on' : 'off',
  },
  TemperatureAction:    {},
  WaterLevelAction:     {},
  PhLevelAction:        {},
  TdsLevelAction:       {},
  HumidityAction:       {},
  AirTemperatureAction: {},
  CO2LevelAction:       {},
  CameraAction:         {},
};

class GoogleExecuteDeviceService {
  public async ExecuteDeviceCommands(ch: Channel, userId: number, commands: any[]): Promise<any> {
    log.info({ userId, commandCount: commands.length }, 'Google EXECUTE intent received');
    const actions = await deviceActionsService.getUserActions(userId);
    const responses: any[] = [];

    for (const command of commands) {
      const deviceIds = command.devices.map((d: any) => parseInt(d.id));
      for (const execution of command.execution) {
        const invalidIds = await this.handleExecuteCommand(ch, userId, execution, actions, deviceIds);
        const validIds = deviceIds.filter((id: number) => !invalidIds.includes(id));
        if (validIds.length) responses.push({ ids: validIds, status: 'SUCCESS', states: { online: true } });
        // Value failed the capability's declared valid_parameters constraint — Google's
        // documented error code for this case.
        if (invalidIds.length) responses.push({ ids: invalidIds, status: 'ERROR', errorCode: 'valueOutOfRange' });
      }
    }

    log.info({ userId, responseCount: responses.length }, 'Google EXECUTE intent processed');
    return responses;
  }

  // Returns the subset of deviceIds whose mapped command value failed valid_parameters.
  private async handleExecuteCommand(
    ch: Channel,
    userId: number,
    execution: SmartHomeV1ExecuteRequestExecution,
    actions: DeviceActionView[],
    deviceIds: number[],
  ): Promise<number[]> {
    const invalidIds: number[] = [];
    for (const deviceId of deviceIds) {
      try {
        const userAction = actions.find(a => a.id === deviceId);
        if (!userAction) {
          log.error({ deviceId, userId }, 'action not found for user');
          continue;
        }

        const deviceValue = this.mapExecutionToValue(execution, userAction.implementation_type, deviceId);
        if (deviceValue === undefined) {
          log.warn({ command: execution.command, implType: userAction.implementation_type, deviceId }, 'no mapping for command');
          continue;
        }

        if (!validateValue(deviceValue, userAction.validParameters)) {
          log.warn({ deviceValue, deviceId }, 'value rejected by valid_parameters');
          invalidIds.push(deviceId);
          continue;
        }

        log.info({ command: execution.command, deviceValue, deviceId }, 'dispatching command');
        await dispatchAction(ch, userId, userAction.id, deviceValue);
      } catch (err) {
        log.error({ deviceId, err }, 'execute failed');
      }
    }
    return invalidIds;
  }

  private mapExecutionToValue(
    execution: SmartHomeV1ExecuteRequestExecution,
    implType: string,
    deviceId: number,
  ): string | undefined {
    const implMap = IMPLEMENTATION_COMMAND_MAP[implType];
    if (!implMap) {
      log.warn({ implType, deviceId }, 'no command map for impl type');
      return undefined;
    }
    const mapper = implMap[execution.command];
    if (!mapper) return undefined;
    return mapper(execution.params ?? {});
  }
}

export const googleExecuteDeviceService = new GoogleExecuteDeviceService();
