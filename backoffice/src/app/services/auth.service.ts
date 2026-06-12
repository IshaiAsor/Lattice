import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { tap } from 'rxjs/operators';
import { Router } from '@angular/router';
import { environment } from 'src/environments/environment';
import { jwtDecode } from 'jwt-decode';
import type { User } from '../models';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly tokenKey = 'access_token';
  private readonly apiUrl   = environment.apiUrl;

  currentUser = signal<User | null>(null);

  constructor(private http: HttpClient, private router: Router) {
    const token = localStorage.getItem(this.tokenKey);
    if (token) {
      try {
        this.currentUser.set(jwtDecode<User>(token));
      } catch {
        this.logout();
      }
    }
  }

  getCurrentUser(): User | null { return this.currentUser(); }

  loginWithUserPass(username: string, password: string) {
    return this.http.post<string>(`${this.apiUrl}/api/auth/login`, { username, password }).pipe(
      tap(token => this.storeToken(token)),
    );
  }

  loginWithGoogle(code: string) {
    return this.http.post<string>(`${this.apiUrl}/api/auth/google`, { code }).pipe(
      tap(token => this.storeToken(token)),
    );
  }

  logout(): void {
    localStorage.removeItem(this.tokenKey);
    this.currentUser.set(null);
    this.router.navigate(['/login']);
  }

  getToken(): string | null { return localStorage.getItem(this.tokenKey); }

  isLoggedIn(): boolean {
    const token = this.getToken();
    if (!token) return false;
    try {
      const { exp } = jwtDecode<{ exp?: number }>(token);
      return exp ? Math.floor(Date.now() / 1000) < exp : true;
    } catch { return false; }
  }

  private storeToken(token: string): void {
    localStorage.setItem(this.tokenKey, token);
    this.currentUser.set(jwtDecode<User>(token));
  }
}
