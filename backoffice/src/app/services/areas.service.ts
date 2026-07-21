import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

// Areas (F10.0): a user-createable "these devices belong together" grouping. Devices carry a
// nullable area_id; deleting an area only un-groups (never deletes the device). Independent of
// blueprints — a blueprint derive (later) will create one and fill it.
export interface AreaView {
  id: number;
  user_id: number;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  device_count: number;
}

@Injectable({ providedIn: 'root' })
export class AreasService {
  private apiUrl = apiUrl();
  private http = inject(HttpClient);

  list(): Observable<AreaView[]> {
    return this.http.get<AreaView[]>(`${this.apiUrl}/api/areas`);
  }

  create(name: string): Observable<AreaView> {
    return this.http.post<AreaView>(`${this.apiUrl}/api/areas`, { name });
  }

  rename(id: number, name: string): Observable<AreaView> {
    return this.http.patch<AreaView>(`${this.apiUrl}/api/areas/${id}`, { name });
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/api/areas/${id}`);
  }

  // Persist a new area order (drives dashboard section order via sort_order).
  reorder(orderedIds: number[]): Observable<void> {
    return this.http.put<void>(`${this.apiUrl}/api/areas/order`, { orderedIds });
  }

  // areaId null clears the tag (moves the devices out of any area).
  assignDevices(areaId: number | null, deviceIds: number[]): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/areas/assign`, { areaId, deviceIds });
  }
}
