import { deriveValidParameters } from '@lattice/capability-validation';
import { db } from '../db';

export interface PinConfigDto {
  pinNumber: number;
  pinMode: 'OUTPUT' | 'INPUT';
}

export interface BehaviorConfigDto {
  behavior: string; // command | interval | on_demand
  // Typed, nullable per behavior (only the relevant fields are set).
  interval_ms: number | null; // interval: resolved cadence (user choice → catalog floor)
  camera_resolution: string | null; // on_demand (camera)
  camera_transport: string | null; // on_demand (camera)
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
  // Unified action model: the behaviors this action instance runs, resolved as
  // user selection → catalog default. The device gates each surface on these (cyclic read iff
  // `interval`, on-demand `read` iff `on_demand`, value commands iff `command`). Empty means
  // fall back to legacy fields (telemetry_interval_ms/camera_*), so old firmware is unaffected.
  behaviors: BehaviorConfigDto[];
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
            configurations: true,
          },
        },
        pins: true,
        configurations: { include: { capability_configuration: true } },
      },
    });

    const actions: ActionConfigDto[] = userActions.map((ua) => {
      // Catalog slot defines the pin mode; the instance assigns the GPIO number. Join by catalog pin id.
      const modeByPinId = new Map(ua.capability.pins.map((p) => [p.id, p.mode]));
      const pins: PinConfigDto[] = ua.pins.map((p) => ({
        pinNumber: p.pin_number,
        pinMode: (modeByPinId.get(p.capability_pin_id) ?? 'OUTPUT') as PinConfigDto['pinMode'],
      }));
      // Resolve behaviors: the user's enabled selections win; otherwise the capability's
      // catalog-declared behaviors are the default (so an action with no explicit selection
      // still runs every behavior its capability supports — matching pre-6d behavior). Interval
      // cadence resolves user choice → catalog floor → legacy telemetry_interval_ms.
      const behaviors: BehaviorConfigDto[] =
        ua.configurations.length > 0
          ? ua.configurations.map((uc) => ({
              behavior: uc.behavior,
              interval_ms: uc.interval_ms ?? uc.capability_configuration.min_interval_ms ?? null,
              camera_resolution: uc.camera_resolution ?? ua.camera_resolution,
              camera_transport: uc.camera_transport ?? ua.camera_transport,
            }))
          : ua.capability.configurations.map((cc) => ({
              behavior: cc.behavior,
              interval_ms:
                cc.behavior === 'interval'
                  ? (ua.telemetry_interval_ms ?? cc.min_interval_ms ?? null)
                  : null,
              camera_resolution: cc.behavior === 'on_demand' ? ua.camera_resolution : null,
              camera_transport: cc.behavior === 'on_demand' ? ua.camera_transport : null,
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
        behaviors,
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
