import db from '../config/db';
import { DeviceModel, ModelAction, Prisma } from '@lattice/prisma-client';

// ─── Device Models (catalog) ─────────────────────────────────────────────────

export type DeviceModelWithActions = DeviceModel & { actions: ModelAction[] };

class CatalogRepository {
  async listModels(): Promise<DeviceModelWithActions[]> {
    return db.deviceModel.findMany({ include: { actions: true }, orderBy: { display_name: 'asc' } });
  }

  async getModelById(id: number): Promise<DeviceModelWithActions> {
    return db.deviceModel.findUniqueOrThrow({ where: { id }, include: { actions: true } });
  }

  async getModelByKey(modelKey: string, version: string): Promise<DeviceModel> {
    return db.deviceModel.findFirstOrThrow({ where: { model_key: modelKey, version } });
  }

  async createModel(data: Pick<DeviceModel, 'model_key' | 'version' | 'display_name'>): Promise<DeviceModel> {
    return db.deviceModel.create({ data });
  }

  async updateModel(id: number, data: Partial<Pick<DeviceModel, 'model_key' | 'version' | 'display_name'>>): Promise<DeviceModel> {
    return db.deviceModel.update({ where: { id }, data: { ...data, updated_at: new Date() } });
  }

  async deleteModel(id: number): Promise<void> {
    await db.deviceModel.delete({ where: { id } });
  }

  // ─── Model Actions ────────────────────────────────────────────────────────

  async listActions(deviceModelId: number): Promise<ModelAction[]> {
    return db.modelAction.findMany({ where: { device_model_id: deviceModelId } });
  }

  async getActionById(id: number): Promise<ModelAction | null> {
    return db.modelAction.findUnique({ where: { id } });
  }

  async createAction(data: {
    device_model_id: number;
    action_key: string;
    capability: string;
    google_action_type_id: number;
    mqtt_type?: string;
    mqtt_name?: string;
    params?: Prisma.InputJsonValue;
    pins?: Prisma.InputJsonValue;
    telemetry_interval_ms?: number | null;
  }): Promise<ModelAction> {
    return db.modelAction.create({ data });
  }

  async updateAction(id: number, data: Partial<{
    action_key: string;
    capability: string;
    google_action_type_id: number;
    mqtt_type: string;
    mqtt_name: string;
    params: Prisma.InputJsonValue;
    pins: Prisma.InputJsonValue;
    telemetry_interval_ms: number | null;
  }>): Promise<ModelAction> {
    return db.modelAction.update({ where: { id }, data });
  }

  async deleteAction(id: number): Promise<void> {
    await db.modelAction.delete({ where: { id } });
  }

  // ─── Upsert helpers (used by import) ─────────────────────────────────────

  async upsertModel(model_key: string, version: string, display_name: string): Promise<{ model: DeviceModel; created: boolean }> {
    const existing = await db.deviceModel.findFirst({ where: { model_key, version } });
    if (existing) {
      const model = await db.deviceModel.update({ where: { id: existing.id }, data: { display_name, updated_at: new Date() } });
      return { model, created: false };
    }
    const model = await db.deviceModel.create({ data: { model_key, version, display_name } });
    return { model, created: true };
  }

  async upsertAction(device_model_id: number, action_key: string, fields: {
    capability: string;
    google_action_type_id: number;
    mqtt_type?: string | null;
    mqtt_name?: string | null;
    params?: Prisma.InputJsonValue;
    pins?: Prisma.InputJsonValue;
    telemetry_interval_ms?: number | null;
  }): Promise<{ action: ModelAction; created: boolean }> {
    const existing = await db.modelAction.findFirst({ where: { device_model_id, action_key } });
    if (existing) {
      const action = await db.modelAction.update({ where: { id: existing.id }, data: fields });
      return { action, created: false };
    }
    const action = await db.modelAction.create({ data: { device_model_id, action_key, ...fields } });
    return { action, created: true };
  }

  async upsertMlModel(kind: string, name: string, fields: {
    version: string;
    description?: string | null;
    config?: Prisma.InputJsonValue;
  }): Promise<{ created: boolean }> {
    const existing = await db.mlModel.findFirst({ where: { kind, name } });
    if (existing) {
      await db.mlModel.update({ where: { id: existing.id }, data: fields });
      return { created: false };
    }
    await db.mlModel.create({ data: { kind, name, ...fields } });
    return { created: true };
  }

  // ─── Google vocab ─────────────────────────────────────────────────────────

  async listGoogleActionTypes() {
    return db.googleActionType.findMany({ orderBy: { name: 'asc' } });
  }

  async listGoogleTraits() {
    return db.googleTrait.findMany({ orderBy: { name: 'asc' } });
  }

  async upsertTraitsForAction(actionId: number, traitIds: number[]): Promise<void> {
    await db.modelActionTrait.deleteMany({ where: { model_action_id: actionId } });
    if (traitIds.length > 0) {
      await db.modelActionTrait.createMany({
        data: traitIds.map((google_trait_id) => ({ model_action_id: actionId, google_trait_id })),
        skipDuplicates: true,
      });
    }
  }
}

export const catalogRepository = new CatalogRepository();
