import type { Channel } from 'amqplib';
import type { ActionResultPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { deviceActionsService } from '../services/device.actions.service';
import { googleHomegraphService } from '../services/google-smart-home/google.homegraph.service';

const log = createLogger('google-home:action-result');

// Consumes device acks and forwards the resulting state to Google HomeGraph.
// Best-effort: errors are logged but the message is still acked so a bad
// HomeGraph call never blocks the queue.
export function actionResultConsumer(_ch: Channel) {
  return async (payload: ActionResultPayload): Promise<void> => {
    const { userId, deviceId, actionName, status } = payload;

    if (status !== 'ok') return;

    try {
      const action = await deviceActionsService.getActionByDeviceAndName(
        parseInt(deviceId, 10),
        actionName,
      );

      if (!action || !action.googleType) return;

      log.info({ userId, deviceId, actionName, actionId: action.id }, 'reporting device state to Google HomeGraph');
      await googleHomegraphService.reportState(userId, action);
    } catch (err) {
      log.error({ deviceId, actionName, err }, 'actionResultConsumer failed');
    }
  };
}
