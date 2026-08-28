import { Channel } from 'amqplib';
import { SmartHomeV1ExecuteRequestExecution } from 'actions-on-google';
import { validateValue } from '@lattice/capability-validation';
import { createLogger } from '@lattice/logger';
import { executeScene } from '@lattice/scenes';
import { deviceActionsService, DeviceActionView } from '../device.actions.service';
import { dispatchAction } from '../command.dispatch';
import { parseGoogleDeviceId } from './google.device-id';

const log = createLogger('google-home:execute');

const ACTIVATE_SCENE = 'action.devices.commands.ActivateScene';

/** One scene Google addressed, keeping the exact id string so the response echoes what it sent. */
interface SceneTarget {
  rawId: string;
  id: number;
}

/**
 * Google's error codes for a scene that would not run. There is no documented code for
 * "temporarily unavailable", so a lifecycle/phase gate reports `notSupported` — which Assistant
 * renders as a plain failure. That is the point: the alternative is answering SUCCESS and leaving
 * the user to notice on their own that nothing in the house moved.
 */
function googleErrorCode(err: unknown): string {
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;
  if (statusCode === 404 || statusCode === 403) return 'deviceNotFound';
  if (statusCode === 409) return 'notSupported';
  return 'unknownError';
}

type ValueMapper = (params: any) => string | undefined;

const IMPLEMENTATION_COMMAND_MAP: Record<string, Record<string, ValueMapper>> = {
  OutletAction: {
    'action.devices.commands.OnOff': (p) => (p.on ? 'on' : 'off'),
    'action.devices.commands.LockUnlock': (p) => (p.lock ? 'on' : 'off'),
    'action.devices.commands.StartStop': (p) => (p.start ? 'on' : 'off'),
    'action.devices.commands.OpenClose': (p) => (p.openPercent > 0 ? 'on' : 'off'),
    'action.devices.commands.ArmDisarm': (p) => (p.arm ? 'arm' : 'disarm'),
  },
  LightDimmerAction: {
    'action.devices.commands.OnOff': (p) => (p.on ? 'on' : 'off'),
    'action.devices.commands.BrightnessAbsolute': (p) => String(p.brightness),
  },
  OneDirectionalMotorAction: {
    'action.devices.commands.OnOff': (p) => (p.on ? 'on' : 'off'),
    'action.devices.commands.SetFanSpeed': (p) =>
      p.fanSpeedPercent !== undefined
        ? String(p.fanSpeedPercent)
        : p.fanSpeed === 'high_speed'
          ? '100'
          : '50',
    'action.devices.commands.StartStop': (p) => (p.start ? 'on' : 'off'),
  },
  TemperatureAction: {},
  WaterLevelAction: {},
  PhLevelAction: {},
  TdsLevelAction: {},
  HumidityAction: {},
  AirTemperatureAction: {},
  CO2LevelAction: {},
  CameraAction: {},
};

class GoogleExecuteDeviceService {
  public async ExecuteDeviceCommands(ch: Channel, userId: number, commands: any[]): Promise<any> {
    log.info({ userId, commandCount: commands.length }, 'Google EXECUTE intent received');
    const actions = await deviceActionsService.getUserActions(userId, '');
    const responses: any[] = [];

    for (const command of commands) {
      // One command can name devices of both kinds, so split before anything looks an id up:
      // an action id and a scene id are separate autoincrements that only the prefix tells apart.
      const deviceIds: number[] = [];
      const scenes: SceneTarget[] = [];
      const unknownIds: string[] = [];
      for (const device of command.devices) {
        const rawId = String(device.id);
        const ref = parseGoogleDeviceId(rawId);
        if (!ref) unknownIds.push(rawId);
        else if (ref.kind === 'scene') scenes.push({ rawId, id: ref.id });
        else deviceIds.push(ref.id);
      }
      if (unknownIds.length) {
        log.warn({ userId, unknownIds }, 'EXECUTE named ids that are not ours');
        responses.push({ ids: unknownIds, status: 'ERROR', errorCode: 'deviceNotFound' });
      }

      for (const execution of command.execution) {
        if (deviceIds.length) {
          const invalidIds = await this.handleExecuteCommand(
            ch,
            userId,
            execution,
            actions,
            deviceIds,
          );
          const validIds = deviceIds.filter((id: number) => !invalidIds.includes(id));
          if (validIds.length)
            responses.push({ ids: validIds, status: 'SUCCESS', states: { online: true } });
          // Value failed the capability's declared valid_parameters constraint — Google's
          // documented error code for this case.
          if (invalidIds.length)
            responses.push({ ids: invalidIds, status: 'ERROR', errorCode: 'valueOutOfRange' });
        }

        if (scenes.length) {
          responses.push(...(await this.executeScenes(ch, userId, execution, scenes)));
        }
      }
    }

    log.info({ userId, responseCount: responses.length }, 'Google EXECUTE intent processed');
    return responses;
  }

  /**
   * "Hey Google, run <scene>" (F7.12). The fan-out is @lattice/scenes — the same call the
   * dashboard tile makes — so the lifecycle/phase gates, the `@param.` resolution and the
   * staggered members are identical on both surfaces rather than reimplemented here.
   */
  private async executeScenes(
    ch: Channel,
    userId: number,
    execution: SmartHomeV1ExecuteRequestExecution,
    scenes: SceneTarget[],
  ): Promise<any[]> {
    const allIds = scenes.map((s) => s.rawId);

    if (execution.command !== ACTIVATE_SCENE) {
      log.warn({ userId, command: execution.command }, 'scene addressed by a non-scene command');
      return [{ ids: allIds, status: 'ERROR', errorCode: 'notSupported' }];
    }
    // SYNC declares sceneReversible:false, so Google should never send this — a Lattice scene
    // stores no "before" to restore. Refuse rather than silently re-running it forwards.
    if ((execution.params as { deactivate?: boolean } | undefined)?.deactivate) {
      return [{ ids: allIds, status: 'ERROR', errorCode: 'notSupported' }];
    }

    const succeeded: string[] = [];
    const failed = new Map<string, string[]>();
    const fail = (rawId: string, errorCode: string): void => {
      const ids = failed.get(errorCode) ?? [];
      ids.push(rawId);
      failed.set(errorCode, ids);
    };

    for (const scene of scenes) {
      try {
        const { queued } = await executeScene(ch, userId, scene.id);
        if (queued === 0) {
          // An empty scene, or one whose every member is a reference resolving to nothing. No
          // command left the process, so SUCCESS would be a lie.
          log.warn({ userId, sceneId: scene.id }, 'scene ran but queued no members');
          fail(scene.rawId, 'unknownError');
          continue;
        }
        log.info({ userId, sceneId: scene.id, queued }, 'scene executed from Google Home');
        succeeded.push(scene.rawId);
      } catch (err) {
        const errorCode = googleErrorCode(err);
        log.warn({ userId, sceneId: scene.id, errorCode, err }, 'scene execution refused');
        fail(scene.rawId, errorCode);
      }
    }

    const responses: any[] = [];
    if (succeeded.length)
      responses.push({ ids: succeeded, status: 'SUCCESS', states: { online: true } });
    for (const [errorCode, ids] of failed) responses.push({ ids, status: 'ERROR', errorCode });
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
        const userAction = actions.find((a) => a.id === deviceId);
        if (!userAction) {
          log.error({ deviceId, userId }, 'action not found for user');
          continue;
        }

        const deviceValue = this.mapExecutionToValue(
          execution,
          userAction.implementation_type,
          deviceId,
        );
        if (deviceValue === undefined) {
          log.warn(
            { command: execution.command, implType: userAction.implementation_type, deviceId },
            'no mapping for command',
          );
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
