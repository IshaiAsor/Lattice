import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { tap } from 'rxjs/operators';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { jwtDecode } from 'jwt-decode';
import { apiUrl } from './api.config';

export interface User {
  id?: number;
  username: string;
  email?: string;
  role?: string;
  user_type?: string | number;
  profileImage?: string;
}

interface AuthResponse {
  token: string;
  refreshToken: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenKey = 'access_token';
  private refreshTokenKey = 'refresh_token';
  private apiUrl = apiUrl();
  private http = inject(HttpClient);
  private router = inject(Router);

  constructor() {
    const token = localStorage.getItem(this.tokenKey);
    if (token) {
      try {
        const decodedUser: User = jwtDecode(token);
        this.currentUser.set(decodedUser);
      } catch {
        this.logout();
      }
    }
  }

  currentUser = signal<User | null>(null);

  getCurrentUser() {
    return this.currentUser();
  }

  getUserInfo(): Observable<User> {
    return this.http.get<User>(`${this.apiUrl}/api/users/me`);
  }

  loginWithUserPass(username: string, password: string) {
    return this.http.post<AuthResponse>(`${this.apiUrl}/api/auth/login`, { username, password }).pipe(
      tap((response) => {
        this.storeTokens(response);
      }),
    );
  }

  loginWithGoogle(code: string, termsAccepted = false) {
    return this.http.post<AuthResponse>(`${this.apiUrl}/api/auth/google`, { code, termsAccepted }).pipe(
      tap((response) => {
        this.storeTokens(response);
      }),
    );
  }

  // Registration no longer logs the user in — it returns { pendingVerification } and an email
  // confirmation link is sent (F15.8). The user lands in the app via verifyEmail().
  register(username: string, email: string, password: string, termsAccepted: boolean) {
    return this.http.post<{ pendingVerification: boolean }>(
      `${this.apiUrl}/api/auth/register`,
      { username, email, password, termsAccepted },
    );
  }

  // Confirm the email via the link token → server returns a full session, so the user lands
  // straight in the app.
  verifyEmail(token: string) {
    return this.http
      .get<AuthResponse>(`${this.apiUrl}/api/auth/verify-email`, { params: { token } })
      .pipe(tap((response) => this.storeTokens(response)));
  }

  resendVerification(email: string) {
    return this.http.post<{ sent: boolean }>(`${this.apiUrl}/api/auth/resend-verification`, { email });
  }

  forgotPassword(email: string) {
    return this.http.post<{ sent: boolean }>(`${this.apiUrl}/api/auth/forgot-password`, { email });
  }

  resetPassword(token: string, password: string) {
    return this.http.post<void>(`${this.apiUrl}/api/auth/reset-password`, { token, password });
  }

  refreshAccessToken(): Observable<AuthResponse> {
    const refreshToken = localStorage.getItem(this.refreshTokenKey);
    return this.http.post<AuthResponse>(`${this.apiUrl}/api/auth/refresh-token`, { refreshToken }).pipe(
      tap((response) => {
        this.storeTokens(response);
      }),
    );
  }

  logout() {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.refreshTokenKey);
    this.currentUser.set(null);
    this.router.navigate(['/login']);
  }

  getToken() {
    return localStorage.getItem(this.tokenKey);
  }

  isLoggedIn(): boolean {
    const token = this.getToken();
    if (!token) {
      return false;
    }
    return !this.isTokenExpired(token);
  }

  private storeTokens(response: AuthResponse): void {
    localStorage.setItem(this.tokenKey, response.token);
    localStorage.setItem(this.refreshTokenKey, response.refreshToken);
    const decodedUser: User = jwtDecode(response.token);
    this.currentUser.set(decodedUser);
  }

  private isTokenExpired(token: string): boolean {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        window
          .atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join(''),
      );

      const payload = JSON.parse(jsonPayload);
      return payload.exp ? Math.floor(Date.now() / 1000) >= payload.exp : false;
    } catch {
      return true;
    }
  }
}
