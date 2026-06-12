import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import type { Pipeline, PipelineStage, PipelineRun } from '../models';

@Injectable({ providedIn: 'root' })
export class PipelineService {
  private readonly base = `${environment.apiUrl}/api/pipelines`;
  private http = inject(HttpClient);

  list()                                   { return this.http.get<Pipeline[]>(this.base); }
  getById(id: number)                      { return this.http.get<Pipeline>(`${this.base}/${id}`); }
  create(d: Partial<Pipeline>)             { return this.http.post<Pipeline>(this.base, d); }
  update(id: number, d: Partial<Pipeline>) { return this.http.patch<Pipeline>(`${this.base}/${id}`, d); }
  toggle(id: number, enabled: boolean)     { return this.http.patch<void>(`${this.base}/${id}/toggle`, { enabled }); }
  delete(id: number)                       { return this.http.delete<void>(`${this.base}/${id}`); }
  trigger(id: number)                      { return this.http.post<{ message: string }>(`${this.base}/${id}/trigger`, {}); }

  setStages(id: number, stages: Partial<PipelineStage>[]) { return this.http.put<Pipeline>(`${this.base}/${id}/stages`, { stages }); }
  getRuns(id: number, limit = 20)          { return this.http.get<PipelineRun[]>(`${this.base}/${id}/runs?limit=${limit}`); }
  importPipelines(data: unknown)           { return this.http.post<{ imported: number }>(`${this.base}/import`, data); }
}
