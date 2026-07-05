import { deriveValidParameters } from '@lattice/capability-validation';
import { db } from '../db';

export interface PinConfigDto {
  pinNumber: number;
  pinMode: 'OUTPUT' | 'INPUT';
}

export interface ActionConfigDto {
  mqtt_action_name: string;
  implementation_type: string;
  mqtt_action_type: string;
  pins: PinConfigDto[];
  telemetry_interval_ms: number | null;
  valid_parameters: unknown;
  // CameraAction only — null/unused for every other implementation_type.
  camera_resolution: string | null;
  camera_transport: string | null;
}

export interface DeviceConfigurationDto {
  device_type: string;
  device_version: string;
  actions: ActionConfigDto[];
}

class DeviceConfigurationService {
  async getConfigurationForDevice(userDeviceId: number): Promise<DeviceConfigurationDto> {
    const userDevice = await db.userDevice.findUnique({
      where: { id: userDeviceId },
      include: { device: true },
    });
    if (!userDevice) throw new Error('Device not found');

    const userActions = await db.userDeviceAction.findMany({
      where: { user_device_id: userDeviceId, status: 'active' },
      include: {
        capability: {
          include: {
            pins: true,
            traits: { include: { google_trait: { select: { valid_parameters: true } } } },
          },
        },
        pins: true,
      },
    });

    const actions: ActionConfigDto[] = userActions.map((ua) => {
      // Catalog slot defines the pin mode; the instance assigns the GPIO number. Join by catalog pin id.
      const modeByPinId = new Map(ua.capability.pins.map((p) => [p.id, p.mode]));
      const pins: PinConfigDto[] = ua.pins.map((p) => ({
        pinNumber: p.pin_number,
        pinMode: (modeByPinId.get(p.capability_pin_id) ?? 'OUTPUT') as PinConfigDto['pinMode'],
      }));
      return {
        mqtt_action_name: ua.mqtt_action_name,
        implementation_type: ua.capability.implementation_type,
        mqtt_action_type: ua.capability.mqtt_action_type ?? 'command',
        pins,
        telemetry_interval_ms:
          ua.telemetry_interval_ms ?? ua.capability.min_telemetry_interval_ms ?? null,
        valid_parameters: deriveValidParameters(
          ua.capability.traits.map((t) => t.google_trait.valid_parameters),
        ),
        camera_resolution: ua.camera_resolution,
        camera_transport: ua.camera_transport,
      };
    });

    return {
      device_type: userDevice.device.type ?? '',
      device_version: userDevice.device.version,
      actions,
    };
  }
}

export const deviceConfigurationService = new DeviceConfigurationService();
