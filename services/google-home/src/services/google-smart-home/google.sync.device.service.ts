import { db } from '@lattice/prisma-client';
import { deviceActionsService, DeviceActionView } from '../device.actions.service';
import { actionDeviceId, sceneDeviceId } from './google.device-id';

class GoogleSyncDevicesService {
  public async SyncUserDevices(userId: number): Promise<any[]> {
    const [actions, scenes] = await Promise.all([
      deviceActionsService.getUserActions(userId, ''),
      this.userScenes(userId),
    ]);

    const actionDevices = actions
      .filter((d) => d.googleType?.value && d.googleTraits.length > 0)
      .map((d) => ({
        id: actionDeviceId(d.id),
        type: d.googleType?.value ?? '',
        traits: d.googleTraits.map((t) => t.value),
        name: { name: d.name, defaultNames: [], nicknames: [] },
        willReportState: true,
        attributes: this.createActionAttributes(d),
      }));

    return [...actionDevices, ...scenes];
  }

  // Scenes (F10.5 → F7.12). A scene is not a capability, so it comes from `scenes` directly
  // rather than through the catalog's googleType/googleTraits mapping — those columns describe
  // what a device can do, and nothing about a scene is a device.
  //
  // Every scene is emitted, including one whose setup is stopped or out of phase. Google caches
  // SYNC and nothing in the platform calls requestSync, so a scene hidden here would stay hidden
  // long after its phase came round; the gates answer at EXECUTE instead, where they can say why.
  private async userScenes(userId: number): Promise<any[]> {
    const scenes = await db.scene.findMany({
      where: { user_id: userId },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
    return scenes.map((s) => ({
      id: sceneDeviceId(s.id),
      type: 'action.devices.types.SCENE',
      traits: ['action.devices.traits.Scene'],
      name: { name: s.name, defaultNames: [], nicknames: [] },
      // A scene has no state to report and none to query: it is a verb, not a thing.
      willReportState: false,
      // Lattice scenes only apply a set of target states — there is no stored "before" to put
      // back, so "turn off <scene>" must not be offered.
      attributes: { sceneReversible: false },
    }));
  }

  private createActionAttributes(action: DeviceActionView): any {
    switch (action.googleType?.value) {
      case 'action.devices.types.SENSOR':
        return { queryOnlyTemperatureSetting: true, thermostatTemperatureUnit: 'C' };
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
