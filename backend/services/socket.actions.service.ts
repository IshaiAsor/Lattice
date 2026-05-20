import socketService from "./socket.service";
import { userDevicesRepository } from "../dal/user.devices.repository";
import { userDevicesActionsRepository } from "../dal/user.devices.actions.repository";
import mqttService from "./mqtt.service";

class SocketActionsService {

  async handleActionUpdate(userId: number, actionId: number, state: string) {
    let userAction = await userDevicesActionsRepository.getById(actionId);
    let userDevice = await userDevicesRepository.getById(userAction.user_device_id);
 
    if (!userAction) {
      console.log(`Action ${actionId} not found`);
      return;
    }

    await userDevicesActionsRepository.updateState(actionId, state);
    mqttService.publishActionState(userId, userDevice.id, userAction.mqtt_action_type, userAction.mqtt_action_name, state);
    socketService.publishActionStateUpdate(userId, actionId, state);
  }

}
export default new SocketActionsService();