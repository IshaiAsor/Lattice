import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';

export interface RuleConditionDto {
  condition_type: 'device_state' | 'threshold' | 'schedule' | 'device_status';
  parameters: Record<string, unknown>;
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
  conditions: RuleConditionDto[];
  actions: RuleActionDto[];
}

export interface UserRuleView extends CreateRuleDto {
  id: number;
  enabled: boolean;
  last_triggered: string | null;
}

@Injectable({ providedIn: 'root' })
export class UserRulesService {
  private apiUrl = `${environment.apiUrl}/api/rules`;
  http = inject(HttpClient);

  getRules(): Observable<UserRuleView[]> {
    return this.http.get<UserRuleView[]>(this.apiUrl);
  }

  createRule(rule: CreateRuleDto): Observable<UserRuleView> {
    return this.http.post<UserRuleView>(this.apiUrl, rule);
  }

  updateRule(id: number, rule: CreateRuleDto): Observable<void> {
    return this.http.put<void>(`${this.apiUrl}/${id}`, rule);
  }

  deleteRule(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  toggleRule(id: number, enabled: boolean): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/${id}/toggle`, { enabled });
  }
}
