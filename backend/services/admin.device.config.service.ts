import { devicesRepository, Device } from '../dal/devices';
import { deviceActionDefinitionRepository, DeviceActionEntity, DeviceActionCreateInput } from '../dal/device.actions.repository';
import { googleTraitsRepository } from '../dal/google.action.traits.repository';
import db from '../config/db';

export class ConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ConflictError'; }
}

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

const MQTT_NAME_RE = /^[a-z0-9_]+$/;

export interface DeviceTypeView {
  id: number;
  type: string;
  version: string;
  default_name: string;
}

export interface DeviceActionView {
  id: number;
  device_id: number;
  default_name: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  implementation_type: string;
  valid_parameters: any;
  pins: any;
  telemetry_interval_ms: number | null;
  google_type_id: number | null;
  google_trait_ids: number[];
}

class AdminDeviceConfigService {
  async listDeviceTypes(): Promise<DeviceTypeView[]> {
    const devices = await devicesRepository.GetAll();
    return devices.map((d) => ({
      id: d.id,
      type: d.type ?? '',
      version: d.version ?? '',
      default_name: d.default_name,
    }));
  }

  async createDeviceType(type: string, version: string, default_name: string): Promise<DeviceTypeView> {
    const device = await devicesRepository.Insert(type, version, default_name);
    return { id: device.id, type: device.type ?? '', version: device.version ?? '', default_name: device.default_name };
  }

  async updateDeviceType(id: number, fields: Partial<Pick<Device, 'type' | 'version' | 'default_name'>>): Promise<DeviceTypeView> {
    const device = await devicesRepository.Update(id, fields);
    return { id: device.id, type: device.type ?? '', version: device.version ?? '', default_name: device.default_name };
  }

  async deleteDeviceType(id: number): Promise<void> {
    await devicesRepository.Delete(id);
  }

  async listActions(deviceId: number): Promise<DeviceActionView[]> {
    const actions = await deviceActionDefinitionRepository.Get(deviceId);
    const traitLinks = await db.actionTypeTrait.findMany({
      where: { device_action_type_id: { in: actions.map((a) => a.id) } },
    });
    return actions.map((a) => this._toView(
      a,
      traitLinks.filter((t) => t.device_action_type_id === a.id).map((t) => t.google_trait_id),
    ));
  }

  async createAction(
    deviceId: number,
    data: Omit<DeviceActionCreateInput, 'device_id'> & { google_trait_ids?: number[] },
  ): Promise<DeviceActionView> {
    if (!data.mqtt_action_name || !MQTT_NAME_RE.test(data.mqtt_action_name)) {
      throw new ValidationError('mqtt_action_name may only contain lowercase letters, digits, and underscores — no spaces or special characters');
    }
    const incomingPins: { pinNumber: number }[] = Array.isArray(data.pins) ? data.pins as any : [];
    if (incomingPins.length > 0) {
      await this._checkPinConflicts(deviceId, incomingPins);
    }
    const { google_trait_ids = [], ...actionData } = data;
    const action = await deviceActionDefinitionRepository.Insert({ ...actionData, device_id: deviceId });
    await googleTraitsRepository.upsertTraitsForAction(action.id, google_trait_ids);
    return this._toView(action, google_trait_ids);
  }

  async updateAction(
    actionId: number,
    data: Omit<Partial<DeviceActionCreateInput>, 'device_id'> & { google_trait_ids?: number[] },
  ): Promise<DeviceActionView> {
    if (data.mqtt_action_name !== undefined && !MQTT_NAME_RE.test(data.mqtt_action_name)) {
      throw new ValidationError('mqtt_action_name may only contain lowercase letters, digits, and underscores — no spaces or special characters');
    }
    const incomingPins: { pinNumber: number }[] = Array.isArray(data.pins) ? data.pins as any : [];
    if (incomingPins.length > 0) {
      const existing = await deviceActionDefinitionRepository.GetById(actionId);
      if (existing) {
        await this._checkPinConflicts(existing.device_id, incomingPins, actionId);
      }
    }
    const { google_trait_ids, ...fields } = data;
    const action = await deviceActionDefinitionRepository.Update(actionId, fields);
    let traitIds = google_trait_ids;
    if (traitIds !== undefined) {
      await googleTraitsRepository.upsertTraitsForAction(actionId, traitIds);
    } else {
      const links = await db.actionTypeTrait.findMany({ where: { device_action_type_id: actionId } });
      traitIds = links.map((l) => l.google_trait_id);
    }
    return this._toView(action, traitIds);
  }

  private async _checkPinConflicts(
    deviceId: number,
    incomingPins: { pinNumber: number }[],
    excludeActionId?: number,
  ): Promise<void> {
    const siblings = await deviceActionDefinitionRepository.Get(deviceId);
    for (const sibling of siblings) {
      if (excludeActionId !== undefined && sibling.id === excludeActionId) continue;
      const siblingPins: { pinNumber: number }[] = Array.isArray(sibling.pins) ? sibling.pins as any : [];
      for (const sp of siblingPins) {
        for (const ip of incomingPins) {
          if (sp.pinNumber === ip.pinNumber) {
            throw new ConflictError(
              `GPIO ${ip.pinNumber} is already used by action '${sibling.mqtt_action_name}'`,
            );
          }
        }
      }
    }
  }

  async deleteAction(actionId: number): Promise<void> {
    await deviceActionDefinitionRepository.Delete(actionId);
  }

  private _toView(action: DeviceActionEntity, google_trait_ids: number[]): DeviceActionView {
    return {
      id: action.id,
      device_id: action.device_id,
      default_name: action.default_name,
      mqtt_action_type: action.mqtt_action_type ?? '',
      mqtt_action_name: action.mqtt_action_name ?? '',
      implementation_type: action.implementation_type,
      valid_parameters: action.valid_parameters,
      pins: action.pins,
      telemetry_interval_ms: (action as any).telemetry_interval_ms ?? null,
      google_type_id: action.google_type_id,
      google_trait_ids,
    };
  }
}

export const adminDeviceConfigService = new AdminDeviceConfigService();
