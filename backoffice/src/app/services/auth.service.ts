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

// Returned by /api/auth/google when the Google identity is brand new: the UI collects Terms
// acceptance in a consent dialog, then finishes signup via completeGoogleSignup(signupToken).
export interface GoogleConsentRequired {
  pendingConsent: true;
  signupToken: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenKey = 'access_token';
  private refreshTokenKey = 'refresh_token';
  private apiUrl = apiUrl();
  private http = inject(HttpClient);
  private router = inject(Router);

  constructor() {
    const token = this.activeStorage().getItem(this.tokenKey);
    if (token) {
      // Don't trust a stored-but-expired token: jwtDecode ignores `exp`, so priming currentUser
      // from an expired session would make getCurrentUser() truthy on the login page and fire
      // authenticated requests (→ 403). Clear the stale tokens and stay logged out.
      if (this.isTokenExpired(token)) {
        this.clearTokens();
        return;
      }
      try {
        const decodedUser: User = jwtDecode(token);
        this.currentUser.set(decodedUser);
      } catch {
        this.clearTokens();
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

  loginWithUserPass(username: string, password: string, remember = true) {
    return this.http.post<AuthResponse>(`${this.apiUrl}/api/auth/login`, { username, password }).pipe(
      tap((response) => {
        this.storeTokens(response, remember);
      }),
    );
  }

  // Per-environment client config. The Google client id can't be baked into the bundle — one
  // backoffice image is promoted staging → prod — so the API serves it from the same env the
  // paired client secret comes from, which keeps the two from drifting apart.
  getAuthConfig() {
    return this.http.get<{ googleClientId: string }>(`${this.apiUrl}/api/auth/config`);
  }

  loginWithGoogle(code: string, remember = true) {
    return this.http
      .post<AuthResponse | GoogleConsentRequired>(`${this.apiUrl}/api/auth/google`, { code })
      .pipe(
        tap((response) => {
          // New Google users come back as { pendingConsent } with no tokens — the caller opens the
          // terms dialog and finishes via completeGoogleSignup. Only store on a real session.
          if (!('pendingConsent' in response)) {
            this.storeTokens(response, remember);
          }
        }),
      );
  }

  completeGoogleSignup(signupToken: string, remember = true) {
    return this.http
      .post<AuthResponse>(`${this.apiUrl}/api/auth/google/complete`, { signupToken })
      .pipe(tap((response) => this.storeTokens(response, remember)));
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
    const refreshToken = this.activeStorage().getItem(this.refreshTokenKey);
    return this.http.post<AuthResponse>(`${this.apiUrl}/api/auth/refresh-token`, { refreshToken }).pipe(
      tap((response) => {
        this.storeTokens(response);
      }),
    );
  }

  logout() {
    this.clearTokens();
    this.router.navigate(['/login']);
  }

  // Drop the session from storage + memory without navigating. Safe to call during construction
  // (logout() adds the redirect to /login on top of this).
  private clearTokens() {
    // Clear both backends — the token may live in either depending on the "Remember me" choice.
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.refreshTokenKey);
    sessionStorage.removeItem(this.tokenKey);
    sessionStorage.removeItem(this.refreshTokenKey);
    this.currentUser.set(null);
  }

  getToken() {
    return this.activeStorage().getItem(this.tokenKey);
  }

  isLoggedIn(): boolean {
    const token = this.getToken();
    if (!token) {
      return false;
    }
    return !this.isTokenExpired(token);
  }

  // Picks where tokens live. When `remember` is given (login paths), the caller chooses:
  // localStorage persists across browser restarts, sessionStorage is cleared when the browser
  // closes. When omitted (e.g. token refresh), reuse whichever backend already holds the token.
  private storageFor(remember?: boolean): Storage {
    if (remember === undefined) {
      return this.activeStorage();
    }
    return remember ? localStorage : sessionStorage;
  }

  // The backend currently holding the session: sessionStorage if a token lives there, else
  // localStorage (also the default when no session exists).
  private activeStorage(): Storage {
    return sessionStorage.getItem(this.tokenKey) ? sessionStorage : localStorage;
  }

  private storeTokens(response: AuthResponse, remember?: boolean): void {
    const storage = this.storageFor(remember);
    // Drop any token in the other backend so a stale session can't be resurrected.
    const other = storage === localStorage ? sessionStorage : localStorage;
    other.removeItem(this.tokenKey);
    other.removeItem(this.refreshTokenKey);
    storage.setItem(this.tokenKey, response.token);
    storage.setItem(this.refreshTokenKey, response.refreshToken);
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
