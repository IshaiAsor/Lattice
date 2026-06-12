import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import type { EmergencyRule, EmergencyEvent } from '../models';

@Injectable({ providedIn: 'root' })
export class EmergencyService {
  private readonly base = `${environment.apiUrl}/api/emergency`;
  private http = inject(HttpClient);

  getRules()                               { return this.http.get<EmergencyRule[]>(`${this.base}/rules`); }
  createRule(d: Partial<EmergencyRule>)    { return this.http.post<EmergencyRule>(`${this.base}/rules`, d); }
  toggle(id: number, enabled: boolean)     { return this.http.patch<void>(`${this.base}/rules/${id}/toggle`, { enabled }); }
  deleteRule(id: number)                   { return this.http.delete<void>(`${this.base}/rules/${id}`); }
  getEvents(limit = 50)                    { return this.http.get<EmergencyEvent[]>(`${this.base}/events?limit=${limit}`); }
  importRules(data: unknown)               { return this.http.post<{ imported: number }>(`${this.base}/rules/import`, data); }
}
