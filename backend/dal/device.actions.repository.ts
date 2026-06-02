import db from '../config/db';
import { DeviceAction, Prisma } from '@prisma/client';

export type DeviceActionEntity = DeviceAction;

export interface DeviceActionCreateInput {
  device_id: number;
  default_name: string;
  google_type_id: number;
  mqtt_action_type: string;
  mqtt_action_name: string;
  implementation_type: string;
  valid_parameters: Prisma.InputJsonValue;
  pins: Prisma.InputJsonValue;
  telemetry_interval_ms?: number | null;
}

class DeviceActionDefinitionRepository {
  async Get(deviceId: number): Promise<DeviceActionEntity[]> {
    return db.deviceAction.findMany({ where: { device_id: deviceId } });
  }

  async GetById(actionId: number): Promise<DeviceActionEntity | null> {
    return db.deviceAction.findUnique({ where: { id: actionId } });
  }

  async GetByActionId(actionId: number): Promise<DeviceActionEntity> {
    return db.deviceAction.findFirstOrThrow({ where: { device_id: actionId } });
  }

  async Insert(data: DeviceActionCreateInput): Promise<DeviceActionEntity> {
    return db.deviceAction.create({
      data: {
        device_id: data.device_id,
        default_name: data.default_name,
        mqtt_action_type: data.mqtt_action_type,
        mqtt_action_name: data.mqtt_action_name,
        implementation_type: data.implementation_type,
        valid_parameters: data.valid_parameters,
        pins: data.pins,
        google_type_id: data.google_type_id,
        telemetry_interval_ms: data.telemetry_interval_ms ?? null,
      },
    });
  }

  async Update(id: number, fields: Omit<Partial<DeviceActionCreateInput>, 'device_id'>): Promise<DeviceActionEntity> {
    return db.deviceAction.update({
      where: { id },
      data: {
        ...(fields.default_name !== undefined ? { default_name: fields.default_name } : {}),
        ...(fields.mqtt_action_type !== undefined ? { mqtt_action_type: fields.mqtt_action_type } : {}),
        ...(fields.mqtt_action_name !== undefined ? { mqtt_action_name: fields.mqtt_action_name } : {}),
        ...(fields.implementation_type !== undefined ? { implementation_type: fields.implementation_type } : {}),
        ...(fields.valid_parameters !== undefined ? { valid_parameters: fields.valid_parameters } : {}),
        ...(fields.pins !== undefined ? { pins: fields.pins } : {}),
        ...(fields.google_type_id != null ? { google_type_id: fields.google_type_id } : {}),
        ...(fields.telemetry_interval_ms !== undefined ? { telemetry_interval_ms: fields.telemetry_interval_ms } : {}),
      },
    });
  }

  async Delete(id: number): Promise<void> {
    await db.deviceAction.delete({ where: { id } });
  }
}

export const deviceActionDefinitionRepository = new DeviceActionDefinitionRepository();
