import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import type { Rule, RuleCondition, RuleAction } from '../models';

export type { Rule, RuleCondition, RuleAction };

export interface CreateRulePayload {
  name: string;
  match: 'AND' | 'OR';
  cooldown_sec: number;
  conditions: Omit<RuleCondition, 'id'>[];
  actions: Omit<RuleAction, 'id'>[];
}

@Injectable({ providedIn: 'root' })
export class UserRulesService {
  private readonly base = `${environment.apiUrl}/api`;
  private http = inject(HttpClient);

  // ── Rules ─────────────────────────────────────────────────────────────────
  getRules()                                       { return this.http.get<Rule[]>(`${this.base}/rules`); }
  createRule(payload: CreateRulePayload)           { return this.http.post<Rule>(`${this.base}/rules`, payload); }
  updateRule(id: number, p: CreateRulePayload)     { return this.http.put<void>(`${this.base}/rules/${id}`, p); }
  toggleRule(id: number, enabled: boolean)         { return this.http.patch<void>(`${this.base}/rules/${id}/toggle`, { enabled }); }
  deleteRule(id: number)                           { return this.http.delete<void>(`${this.base}/rules/${id}`); }

  // ── AI rules ──────────────────────────────────────────────────────────────
  aiGenerate(goal: string, context?: string)       { return this.http.post<{ rules: CreateRulePayload[] }>(`${this.base}/ai/rules/generate`, { goal, context }); }
  aiApply(rules: CreateRulePayload[])              { return this.http.post<void>(`${this.base}/ai/rules/apply`, { rules }); }
  aiList()                                         { return this.http.get<Rule[]>(`${this.base}/ai/rules`); }
  aiClear()                                        { return this.http.delete<{ deleted: number }>(`${this.base}/ai/rules`); }

  importRules(data: unknown)                       { return this.http.post<{ imported: number }>(`${this.base}/rules/import`, data); }
}
