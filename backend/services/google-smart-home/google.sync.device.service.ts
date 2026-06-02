import { deviceActionsService, DeviceActionView } from './../device.actions.service';

class GoogleSyncDevicesService {
  public async SyncUserDevices(userId: number): Promise<any[]> {
    // This is a placeholder implementation. You should replace it with actual logic to fetch and format the user's devices.
    const actions = await deviceActionsService.getUserActions(userId);

    const syncDevices = actions.filter((d) => d.googleType?.value && d.googleTraits.length > 0).map((d) => ({
      id: d.id.toString(),
      type: d.googleType?.value || '',
      traits: d.googleTraits.map((t) => t.value),
      name: { name: d.name, defaultNames: [], nicknames: [] },
      willReportState: false, //TODO: Set this to true after implementing state reporting
      attributes: this.createActionAttributes(d),
    }));
    return syncDevices;
  }

  private createActionAttributes(action: DeviceActionView): any {
    switch (action.googleType?.value) {
      case 'action.devices.types.SENSOR':
        return {
          queryOnlyTemperatureSetting: true,
          thermostatTemperatureUnit: 'C',
        };
      case 'action.devices.types.FAN':
        return {
          reversible: true,
          supportsFanSpeedPercent: true,
          availableFanSpeeds: {
            speeds: [
              {
                speed_name: 'low_speed',
                speed_values: [{ speed_synonym: ['low', 'slow', 'speed one'], lang: 'en' }],
              },
              {
                speed_name: 'high_speed',
                speed_values: [{ speed_synonym: ['high', 'fast', 'speed two'], lang: 'en' }],
              },
            ],
            ordered: true,
          },
        };
      case 'action.devices.types.CAMERA':
        // Registers the camera device type. Actual streaming requires a relay server
        // (ESP32 sends JPEG frames via WebSocket, not via Google's streaming protocols).
        return {
          cameraStreamSupportedProtocols: ['progressive_mp4'],
          cameraStreamNeedAuthToken: false,
        };
      default:
        return undefined;
    }
  }
}
export const googleSyncDevicesService = new GoogleSyncDevicesService();
