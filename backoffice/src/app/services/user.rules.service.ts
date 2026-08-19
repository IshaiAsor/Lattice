import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

// Typed conditions (F1.7) — no more `parameters` blob. Fields are populated per
// condition_type; the rest stay null.
export interface RuleConditionDto {
  condition_type: 'device_state' | 'device_status' | 'threshold' | 'schedule';
  user_device_action_id?: number | null;
  operator?: string | null;
  threshold_value?: string | null;
  user_device_id?: number | null;
  status_value?: string | null;
  schedule_time?: string | null;
  /** With `schedule_every_minutes`, repeats from schedule_time through this each day. */
  schedule_until?: string | null;
  schedule_every_minutes?: number | null;
  schedule_days?: number[];
}

export interface RuleActionDto {
  user_device_action_id: number;
  target_state: string;
  delay_seconds: number;
}

export interface CreateRuleDto {
  name: string;
  condition_operator: 'AND' | 'OR';
  cooldown_seconds: number;
  is_emergency: boolean;
  conditions: RuleConditionDto[];
  actions: RuleActionDto[];
}

export interface UserRuleView extends CreateRuleDto {
  id: number;
  enabled: boolean;
  last_triggered: string | null;
  conditions: (RuleConditionDto & { id: number })[];
  actions: (RuleActionDto & { id: number })[];
}

/** One recorded firing of a rule (UserRuleEvent), newest first from `GET /events`. */
export interface RuleEventView {
  id: number;
  rule_id: number;
  triggered_value: string | null;
  fired_at: string;
}

@Injectable({ providedIn: 'root' })
export class UserRulesService {
  private apiUrl = `${apiUrl()}/api/rules`;
  http = inject(HttpClient);

  getRules(): Observable<UserRuleView[]> {
    return this.http.get<UserRuleView[]>(this.apiUrl);
  }

  /** Fire events across all the user's rules — the list's "Fired (24h)" stat and per-rule history. */
  getEvents(limit = 200): Observable<RuleEventView[]> {
    return this.http.get<RuleEventView[]>(`${this.apiUrl}/events`, {
      params: { limit: String(limit) },
    });
  }

  createRule(rule: CreateRuleDto): Observable<UserRuleView> {
    return this.http.post<UserRuleView>(this.apiUrl, rule);
  }

  updateRule(id: number, rule: CreateRuleDto): Observable<UserRuleView> {
    return this.http.put<UserRuleView>(`${this.apiUrl}/${id}`, rule);
  }

  deleteRule(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  toggleRule(id: number, enabled: boolean): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/${id}/toggle`, { enabled });
  }
}
