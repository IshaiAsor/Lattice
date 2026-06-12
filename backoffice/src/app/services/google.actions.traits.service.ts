import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import type { GoogleTrait } from '../models';

export type { GoogleTrait } from '../models';

// Legacy alias — components using GoogleActionTrait can keep their imports
export type GoogleActionTrait = GoogleTrait;

@Injectable({ providedIn: 'root' })
export class GoogleActionsTraitsService {
  private apiUrl = environment.apiUrl;
  constructor(private http: HttpClient) {}
  getGoogleActionTraits() { return this.http.get<GoogleTrait[]>(`${this.apiUrl}/api/google/actions/traits`); }
}
