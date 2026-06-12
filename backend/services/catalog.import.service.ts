import { catalogRepository } from '../dal/catalog.repository';
import db from '../config/db';

export interface CatalogImportAction {
  action_key: string;
  capability: string;
  google_action_type_key: string;
  mqtt_type?: string | null;
  mqtt_name?: string | null;
  telemetry_interval_ms?: number | null;
  params?: Record<string, unknown>;
  pins?: Record<string, unknown>;
  google_trait_keys?: string[];
}

export interface CatalogImportModel {
  model_key: string;
  version: string;
  display_name: string;
  actions?: CatalogImportAction[];
}

export interface MlModelImport {
  kind: string;
  name: string;
  version: string;
  description?: string | null;
  config?: Record<string, unknown>;
}

export interface CatalogImportPayload {
  version?: string;
  models?: CatalogImportModel[];
  ml_models?: MlModelImport[];
}

export interface ImportResult {
  models_created: number;
  models_updated: number;
  actions_created: number;
  actions_updated: number;
  ml_models_created: number;
  ml_models_updated: number;
  errors: string[];
}

class CatalogImportService {
  async importCatalog(payload: CatalogImportPayload): Promise<ImportResult> {
    const result: ImportResult = {
      models_created: 0, models_updated: 0,
      actions_created: 0, actions_updated: 0,
      ml_models_created: 0, ml_models_updated: 0,
      errors: [],
    };

    // Build key→id lookup maps for Google vocab
    const [actionTypes, traits] = await Promise.all([
      catalogRepository.listGoogleActionTypes(),
      catalogRepository.listGoogleTraits(),
    ]);
    const actionTypeKeyToId = new Map(actionTypes.map(t => [t.key, t.id]));
    const traitKeyToId      = new Map(traits.map(t => [t.key, t.id]));

    for (const m of payload.models ?? []) {
      try {
        const { model, created } = await catalogRepository.upsertModel(m.model_key, m.version, m.display_name);
        created ? result.models_created++ : result.models_updated++;

        for (const a of m.actions ?? []) {
          try {
            const googleTypeId = actionTypeKeyToId.get(a.google_action_type_key);
            if (!googleTypeId) {
              result.errors.push(`Unknown google_action_type_key "${a.google_action_type_key}" for action "${a.action_key}"`);
              continue;
            }

            const { action, created: ac } = await catalogRepository.upsertAction(model.id, a.action_key, {
              capability:           a.capability,
              google_action_type_id: googleTypeId,
              mqtt_type:            a.mqtt_type ?? null,
              mqtt_name:            a.mqtt_name ?? null,
              telemetry_interval_ms: a.telemetry_interval_ms ?? null,
              params:               (a.params ?? {}) as any,
              pins:                 (a.pins  ?? {}) as any,
            });
            ac ? result.actions_created++ : result.actions_updated++;

            if (a.google_trait_keys?.length) {
              const traitIds = a.google_trait_keys
                .map(k => traitKeyToId.get(k))
                .filter((id): id is number => id !== undefined);
              const unknown = a.google_trait_keys.filter(k => !traitKeyToId.has(k));
              if (unknown.length) result.errors.push(`Unknown trait keys for action "${a.action_key}": ${unknown.join(', ')}`);
              await catalogRepository.upsertTraitsForAction(action.id, traitIds);
            }
          } catch (e: any) {
            result.errors.push(`Action "${a.action_key}": ${e.message}`);
          }
        }
      } catch (e: any) {
        result.errors.push(`Model "${m.model_key}@${m.version}": ${e.message}`);
      }
    }

    for (const ml of payload.ml_models ?? []) {
      try {
        const { created } = await catalogRepository.upsertMlModel(ml.kind, ml.name, {
          version:     ml.version,
          description: ml.description ?? null,
          config:      (ml.config ?? {}) as any,
        });
        created ? result.ml_models_created++ : result.ml_models_updated++;
      } catch (e: any) {
        result.errors.push(`MlModel "${ml.name}": ${e.message}`);
      }
    }

    return result;
  }
}

export const catalogImportService = new CatalogImportService();
