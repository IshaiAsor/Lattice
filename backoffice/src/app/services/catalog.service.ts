import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import type { DeviceModel, ModelAction, MlModel, GoogleActionType, GoogleTrait } from '../models';

@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly base = `${environment.apiUrl}/api/admin/catalog`;
  private http = inject(HttpClient);

  // ── Device models ─────────────────────────────────────────────────────────
  getModels()                                          { return this.http.get<DeviceModel[]>(`${this.base}/models`); }
  createModel(d: Pick<DeviceModel,'model_key'|'version'|'display_name'>) { return this.http.post<DeviceModel>(`${this.base}/models`, d); }
  updateModel(id: number, d: Partial<DeviceModel>)    { return this.http.patch<DeviceModel>(`${this.base}/models/${id}`, d); }
  deleteModel(id: number)                             { return this.http.delete<void>(`${this.base}/models/${id}`); }

  // ── Model actions ─────────────────────────────────────────────────────────
  getActions(modelId: number)                         { return this.http.get<ModelAction[]>(`${this.base}/models/${modelId}/actions`); }
  createAction(modelId: number, d: Partial<ModelAction> & { trait_ids?: number[] }) {
    return this.http.post<ModelAction>(`${this.base}/models/${modelId}/actions`, d);
  }
  updateAction(actionId: number, d: Partial<ModelAction> & { trait_ids?: number[] }) {
    return this.http.patch<ModelAction>(`${this.base}/actions/${actionId}`, d);
  }
  deleteAction(actionId: number)                      { return this.http.delete<void>(`${this.base}/actions/${actionId}`); }

  // ── ML models ─────────────────────────────────────────────────────────────
  getMlModels()                                       { return this.http.get<MlModel[]>(`${this.base}/ml-models`); }
  createMlModel(d: Partial<MlModel>)                  { return this.http.post<MlModel>(`${this.base}/ml-models`, d); }
  updateMlModel(id: number, d: Partial<MlModel>)      { return this.http.patch<MlModel>(`${this.base}/ml-models/${id}`, d); }
  deleteMlModel(id: number)                           { return this.http.delete<void>(`${this.base}/ml-models/${id}`); }

  // ── Google vocab (read-only) ──────────────────────────────────────────────
  getGoogleActionTypes()                              { return this.http.get<GoogleActionType[]>(`${this.base}/google-action-types`); }
  getGoogleTraits()                                   { return this.http.get<GoogleTrait[]>(`${this.base}/google-traits`); }

  // ── Import ────────────────────────────────────────────────────────────────
  importCatalog(data: unknown) { return this.http.post<{ models_created: number; models_updated: number; actions_created: number; actions_updated: number; ml_models_created: number; ml_models_updated: number; errors: string[] }>(`${this.base}/import`, data); }
}
