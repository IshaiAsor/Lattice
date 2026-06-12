import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import type { GoogleActionType } from '../models';

export type { GoogleActionType } from '../models';

@Injectable({ providedIn: 'root' })
export class GoogleActionsTypesService {
  private apiUrl = environment.apiUrl;
  constructor(private http: HttpClient) {}
  getGoogleActionTypes() { return this.http.get<GoogleActionType[]>(`${this.apiUrl}/api/google/actions/types`); }
}
