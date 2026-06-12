import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import type { UserAction, UserActionGroup } from '../models';

@Injectable({ providedIn: 'root' })
export class UserActionsService {
  private readonly apiUrl = environment.apiUrl;
  private http = inject(HttpClient);

  // ── Actions ───────────────────────────────────────────────────────────────
  getUserActions()                                        { return this.http.get<UserAction[]>(`${this.apiUrl}/api/mgmt/actions`); }
  updateAction(id: number, data: Partial<UserAction>)    { return this.http.patch<UserAction>(`${this.apiUrl}/api/mgmt/actions/${id}`, data); }
  reorderActions(orderedIds: number[])                   { return this.http.put<void>(`${this.apiUrl}/api/mgmt/actions/order`, { orderedIds }); }
  setActionGroup(actionId: number, groupId: number|null) { return this.http.patch<void>(`${this.apiUrl}/api/mgmt/actions/${actionId}`, { user_action_group_id: groupId }); }

  // ── Action groups ─────────────────────────────────────────────────────────
  getGroups()                                            { return this.http.get<UserActionGroup[]>(`${this.apiUrl}/api/mgmt/actions/groups`); }
  createGroup(data: Partial<UserActionGroup>)            { return this.http.post<UserActionGroup>(`${this.apiUrl}/api/mgmt/actions/groups`, data); }
  updateGroup(id: number, data: Partial<UserActionGroup>){ return this.http.patch<UserActionGroup>(`${this.apiUrl}/api/mgmt/actions/groups/${id}`, data); }
  deleteGroup(id: number)                                { return this.http.delete<void>(`${this.apiUrl}/api/mgmt/actions/groups/${id}`); }
  reorderGroups(orderedIds: number[])                    { return this.http.put<void>(`${this.apiUrl}/api/mgmt/actions/groups/order`, { orderedIds }); }
}
