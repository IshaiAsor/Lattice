import socketService from "./socket.service";
import { userDevicesRepository } from "../dal/user.devices.repository";
import { userDevicesActionsRepository } from "../dal/user.devices.actions.repository";
import mqttService, { MqttChannel } from "./mqtt.service";
import { rulesEngineService } from "./rules.engine.service";

class SocketActionsService {

  async handleActionUpdate(userId: number, actionId: number, state: string, duration: string = '*') {
    let userAction = await userDevicesActionsRepository.getById(actionId);
    if (!userAction) {
      console.log(`Action ${actionId} not found`);
      return;
    }
    let userDevice = await userDevicesRepository.getById(userAction.user_device_id);
    if(!userDevice) {
      console.log(`Device ${userAction.user_device_id} not found for action ${actionId}`);
      return;
    }
    if (!userAction) {
      console.log(`Action ${actionId} not found`);
      return;
    }

    await userDevicesActionsRepository.updateState(actionId, state);
    const payload = JSON.stringify({ value: state, duration });
    await mqttService.publish(userId, userDevice.id, (userAction.action.mqtt_action_type ?? 'command') as MqttChannel, userAction.action.mqtt_action_name ?? '', payload);
    socketService.publishActionStateUpdate(userId, actionId, state);
    rulesEngineService.evaluateForUser(userId);
  }

}
export default new SocketActionsService();