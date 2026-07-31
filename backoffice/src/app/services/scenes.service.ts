import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

// Scenes (F10.5) — a named set of device actions fired on demand. Unlike an action group
// (an organizational folder), a scene member carries the target value to apply.

export interface SceneMemberDto {
  user_device_action_id: number;
  target_state: string;
  sort_order?: number;
  delay_seconds?: number;
}

export interface CreateSceneDto {
  name: string;
  sort_order?: number;
  members: SceneMemberDto[];
}

export interface SceneView {
  id: number;
  name: string;
  sort_order: number;
  members: (SceneMemberDto & { id: number; sort_order: number; delay_seconds: number })[];
  // Phase scope (F10): the phases a blueprint-derived scene is offered in (empty = all), and
  // whether its setup is currently in one of them. `in_phase` is always true for hand-made scenes.
  phase_scope: string[];
  in_phase: boolean;
}

@Injectable({ providedIn: 'root' })
export class ScenesService {
  private apiUrl = `${apiUrl()}/api/scenes`;
  http = inject(HttpClient);

  getScenes(): Observable<SceneView[]> {
    return this.http.get<SceneView[]>(this.apiUrl);
  }

  createScene(scene: CreateSceneDto): Observable<SceneView> {
    return this.http.post<SceneView>(this.apiUrl, scene);
  }

  updateScene(id: number, scene: CreateSceneDto): Observable<SceneView> {
    return this.http.put<SceneView>(`${this.apiUrl}/${id}`, scene);
  }

  deleteScene(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  // 202 Accepted — device acks arrive over the socket, not in this response.
  execute(id: number): Observable<{ queued: number }> {
    return this.http.post<{ queued: number }>(`${this.apiUrl}/${id}/execute`, {});
  }
}
