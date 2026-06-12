import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import type { Blueprint } from '../models';

@Injectable({ providedIn: 'root' })
export class BlueprintService {
  private readonly base = `${environment.apiUrl}/api`;
  private http = inject(HttpClient);

  // ── User (gallery + derive) ───────────────────────────────────────────────
  listPublished()                          { return this.http.get<Blueprint[]>(`${this.base}/blueprints`); }
  getById(id: number)                      { return this.http.get<Blueprint>(`${this.base}/blueprints/${id}`); }
  derive(id: number)                       { return this.http.post<{ userBlueprintId: number }>(`${this.base}/blueprints/${id}/derive`, {}); }

  // ── Admin CRUD ────────────────────────────────────────────────────────────
  listAll()                                { return this.http.get<Blueprint[]>(`${this.base}/admin/blueprints`); }
  getFullById(id: number)                  { return this.http.get<Blueprint>(`${this.base}/admin/blueprints/${id}`); }
  create(d: Pick<Blueprint,'name'|'description'|'category'>) { return this.http.post<Blueprint>(`${this.base}/admin/blueprints`, d); }
  update(id: number, d: Partial<Blueprint>){ return this.http.patch<Blueprint>(`${this.base}/admin/blueprints/${id}`, d); }
  publish(id: number)                      { return this.http.patch<Blueprint>(`${this.base}/admin/blueprints/${id}/publish`, {}); }
  delete(id: number)                       { return this.http.delete<void>(`${this.base}/admin/blueprints/${id}`); }

  // ── Sub-resources (admin) ─────────────────────────────────────────────────
  addSlot(bpId: number, d: any)            { return this.http.post<any>(`${this.base}/admin/blueprints/${bpId}/slots`, d); }
  deleteSlot(bpId: number, slotId: number) { return this.http.delete<void>(`${this.base}/admin/blueprints/${bpId}/slots/${slotId}`); }

  addActionGroup(bpId: number, d: any)     { return this.http.post<any>(`${this.base}/admin/blueprints/${bpId}/action-groups`, d); }
  deleteActionGroup(bpId: number, gid: number) { return this.http.delete<void>(`${this.base}/admin/blueprints/${bpId}/action-groups/${gid}`); }

  addPipeline(bpId: number, d: any)        { return this.http.post<any>(`${this.base}/admin/blueprints/${bpId}/pipelines`, d); }
  deletePipeline(bpId: number, pid: number){ return this.http.delete<void>(`${this.base}/admin/blueprints/${bpId}/pipelines/${pid}`); }
  addStage(bpId: number, pid: number, d: any) { return this.http.post<any>(`${this.base}/admin/blueprints/${bpId}/pipelines/${pid}/stages`, d); }
  deleteStage(bpId: number, pid: number, sid: number) { return this.http.delete<void>(`${this.base}/admin/blueprints/${bpId}/pipelines/${pid}/stages/${sid}`); }

  addRule(bpId: number, d: any)            { return this.http.post<any>(`${this.base}/admin/blueprints/${bpId}/rules`, d); }
  deleteRule(bpId: number, rid: number)    { return this.http.delete<void>(`${this.base}/admin/blueprints/${bpId}/rules/${rid}`); }
  addRuleCondition(bpId: number, rid: number, d: any) { return this.http.post<any>(`${this.base}/admin/blueprints/${bpId}/rules/${rid}/conditions`, d); }
  deleteRuleCondition(bpId: number, rid: number, cid: number) { return this.http.delete<void>(`${this.base}/admin/blueprints/${bpId}/rules/${rid}/conditions/${cid}`); }
  addRuleAction(bpId: number, rid: number, d: any) { return this.http.post<any>(`${this.base}/admin/blueprints/${bpId}/rules/${rid}/actions`, d); }
  deleteRuleAction(bpId: number, rid: number, aid: number) { return this.http.delete<void>(`${this.base}/admin/blueprints/${bpId}/rules/${rid}/actions/${aid}`); }

  addEmergencyRule(bpId: number, d: any)   { return this.http.post<any>(`${this.base}/admin/blueprints/${bpId}/emergency-rules`, d); }
  updateEmergencyRule(bpId: number, eid: number, d: any) { return this.http.patch<any>(`${this.base}/admin/blueprints/${bpId}/emergency-rules/${eid}`, d); }
  deleteEmergencyRule(bpId: number, eid: number) { return this.http.delete<void>(`${this.base}/admin/blueprints/${bpId}/emergency-rules/${eid}`); }

  // ── Import ────────────────────────────────────────────────────────────────
  importBlueprints(data: unknown) { return this.http.post<{ imported: number; blueprints: { id: number; name: string }[] }>(`${this.base}/admin/blueprints/import`, data); }
}
