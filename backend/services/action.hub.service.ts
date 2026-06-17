import commandDispatch from './command.dispatch.service';
import { rulesEngineService } from './rules.engine.service';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { sensorHistoryRepository } from '../dal/sensor.history.repository';
import { emergencyService } from './emergency.service';


export type ActionSource = 'mqtt' | 'socket' | 'rules' | 'google';

export interface DispatchOptions {
  skipMqttPublish?: boolean;
  skipRulesEval?: boolean;
  duration?: string;
}

class ActionHubService {
  async dispatch(
    userId: number,
    actionId: number,
    state: string,
    source: ActionSource,
    options: DispatchOptions = {},
  ): Promise<void> {
    console.log(`[ActionHub] ${source} userId=${userId} actionId=${actionId} state=${state}`);

    const action = await userDevicesActionsRepository.getById(actionId);
    if (!action) {
      console.log(`[ActionHub] Action ${actionId} not found`);
      return;
    }

    await userDevicesActionsRepository.updateState(actionId, state);

    if (!options.skipMqttPublish) {
      const command = { value: state, duration: options.duration ?? '*' };
      await commandDispatch.publishCommand(userId, action.user_device_id, action.mqtt_action_name, command);
    }

    // Record sensor history and check emergency rules for telemetry sources (non-camera)
    if (source === 'mqtt') {
      const implType = action.action.implementation_type;
      const isCamera = implType === 'LiveStreamAction' || implType === 'TakePictureAction' ||
                       implType === 'LiveStreamHttpAction' || implType === 'TakePictureHttpAction';
      if (!isCamera) {
        sensorHistoryRepository.insert(actionId, state).catch(err =>
          console.error('[ActionHub] SensorHistory insert error:', err)
        );
        emergencyService.checkEmergency(userId, actionId, state).catch(err =>
          console.error('[ActionHub] Emergency check error:', err)
        );
      }
    }

    if (!options.skipRulesEval) {
      rulesEngineService.evaluateForUser(userId);
    }
  }
}

export const actionHubService = new ActionHubService();
