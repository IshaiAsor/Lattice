import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { switchMap, tap } from 'rxjs/operators';
import { Router } from '@angular/router';
import { environment } from 'src/environments/environment';
import { Observable } from 'rxjs';
import { jwtDecode } from 'jwt-decode';

export interface User {
  username: string;
  email?: string;
  role?: any;
  user_type?: any;
  profileImage?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenKey = 'access_token';
  private apiUrl = `${environment.apiUrl}`;

  constructor(
    private http: HttpClient,
    private router: Router,
  ) {
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
    return this.http.get<User>(`${this.apiUrl}/api/auth/user-info`);
  }

  loginWithUserPass(username: string, password: string) {
    return this.http.post<string>(`${this.apiUrl}/api/auth/login`, { username, password }).pipe(
      tap((token) => {
        localStorage.setItem(this.tokenKey, token);
        const decodedUser: User = jwtDecode(token);
        this.currentUser.set(decodedUser);
        console.log(decodedUser);
      }),
    );
  }

  loginWithGoogle(code: string) {
    return this.http.post<string>(`${this.apiUrl}/api/auth/google`, { code }).pipe(
      tap((token) => {
        localStorage.setItem(this.tokenKey, token);
        const decodedUser: User = jwtDecode(token);
        this.currentUser.set(decodedUser);
        console.log(decodedUser);
      }),
    );
  }

  logout() {
    localStorage.removeItem(this.tokenKey);
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

  private isTokenExpired(token: string): boolean {
    try {
      // JWT is composed of 3 parts: header, payload, signature.
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
      // The 'exp' claim is in seconds, Date.now() is in milliseconds
      return payload.exp ? Math.floor(Date.now() / 1000) >= payload.exp : false;
    } catch (e) {
      return true; // If the token is malformed, consider it expired/invalid
    }
  }
}
