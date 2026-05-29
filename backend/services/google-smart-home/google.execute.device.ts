import { SmartHomeV1ExecuteRequestExecution } from 'actions-on-google';
import { deviceActionsService, DeviceActionView } from '../device.actions.service';
import socketActionsService from '../socket.actions.service';

class GoogleExecuteDeviceService {
  public async ExecuteDeviceCommands(userId: number, commands: any[]): Promise<any> {
    const actions = await deviceActionsService.getUserActions(userId);

    const responses = commands.map((command) => {
      const deviceIds = command.devices.map((d: any) => parseInt(d.id));

      command.execution.forEach(async (execution: SmartHomeV1ExecuteRequestExecution) => {
        await this.HandleExecuteCommand(userId, execution, actions, deviceIds);
      });

      return {
        ids: deviceIds,
        status: 'SUCCESS',
        states: {
          online: true,
          ...(command.execution[0].params as object),
        },
      };
    });

    return responses;
  }

  private async HandleExecuteCommand(
    userId: number,
    execution: SmartHomeV1ExecuteRequestExecution,
    actions: DeviceActionView[],
    deviceIds: number[],
  ): Promise<string[]> {
    let successIds: string[] = [];
    for (const deviceId of deviceIds) {
      try {
        const userAction = actions.find((a) => a.id === deviceId);
        if (!userAction) {
          console.error(`Action ${deviceId} not found for user ${userId}`);
          continue;
        }

        let deviceValue: string | undefined = undefined; // You can extract this from execution.params if needed for more complex commands

        deviceValue = this.MapDeviceValue(execution, deviceValue, deviceId);
        if (deviceValue === undefined) {
          console.warn(`No value extracted for command ${execution.command} on device ${deviceId}`);
          continue;
        } else {
          console.log(
            `Extracted value for command ${execution.command} on device ${deviceId}: ${deviceValue}`,
          );
          await socketActionsService.handleActionUpdate(userId, userAction.id, deviceValue);
        }
        successIds.push(deviceId.toString());
        console.log(`Successfully executed command on device ${deviceId}`);
      } catch (err) {
        console.error(`Failed to execute command on device ${deviceId}:`, err);
      }
    }
    return successIds;
  }

    private MapDeviceValue(execution: SmartHomeV1ExecuteRequestExecution, deviceValue: string | undefined, deviceId: number) {
        switch (execution.command) {
            case 'action.devices.commands.OnOff':
                deviceValue = execution.params?.on ? 'on' : 'off';
                break;
            case 'action.devices.commands.SetFanSpeed':
                const params = execution.params as { fanSpeed?: string; fanSpeedPercent?: number; };
                if (params.fanSpeedPercent !== undefined) {
                    deviceValue = params.fanSpeedPercent.toString();
                } else if (params.fanSpeed) {
                    switch (params.fanSpeed) {
                        case 'low_speed':
                            deviceValue = '50';
                            break;
                        case 'high_speed':
                            deviceValue = '100';
                            break;
                        default:
                            console.warn(`Unsupported fan speed ${params.fanSpeed} for device ${deviceId}`);
                    }
                }
                break;
            case 'action.devices.commands.SetTemperature':
                const tempParams = execution.params as { temperature?: number; };
                if (tempParams.temperature !== undefined) {
                    deviceValue = tempParams.temperature.toString();
                }
                break;

            default:
                console.warn(`Unsupported command ${execution.command} for device ${deviceId}`);
                break;
        }
        return deviceValue;
    }
}
export const googleExecuteDeviceService = new GoogleExecuteDeviceService();