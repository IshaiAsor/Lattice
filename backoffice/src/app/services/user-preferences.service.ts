import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { apiUrl } from './api.config';
import { SILENT_ERRORS } from './error.interceptor';

export interface UserProfile {
  id: number;
  username: string | null;
  email: string;
  role: string;
  user_type: number;
  profileImage: string | null;
  /** IANA zone every schedule this user writes is read against. Null = the server's own zone. */
  timezone: string | null;
}

/** What this browser thinks it is in — the default, and what the picker preselects. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Every zone the browser knows, for the picker.
 *
 * `Intl.supportedValuesOf` is recent enough that a runtime without it is plausible; there the list
 * collapses to the one zone that actually matters — the user's own — which still lets them save.
 */
export function allTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones?.length) return zones;
  } catch {
    /* fall through */
  }
  return [browserTimeZone(), 'UTC'];
}

@Injectable({ providedIn: 'root' })
export class UserPreferencesService {
  private http = inject(HttpClient);
  private base = apiUrl();

  /** The signed-in user's stored timezone, once loaded. Null until then, and for a user who has none. */
  timezone = signal<string | null>(null);

  // Both calls opt out of the generic error toast: one is a background adoption the user never
  // asked for, and the other is a dialog that says something better itself. A stale API image
  // answering 404 here should not put a raw error in front of someone loading their dashboard.
  private silent = new HttpContext().set(SILENT_ERRORS, true);

  load(): Observable<UserProfile> {
    return this.http
      .get<UserProfile>(`${this.base}/api/users/me`, { context: this.silent })
      .pipe(tap((u) => this.timezone.set(u.timezone)));
  }

  setTimezone(timezone: string | null): Observable<UserProfile> {
    return this.http
      .patch<UserProfile>(
        `${this.base}/api/users/me/timezone`,
        { timezone },
        { context: this.silent },
      )
      .pipe(tap((u) => this.timezone.set(u.timezone)));
  }

  /**
   * Make "local" the default without asking.
   *
   * A user who never opens the picker still has schedules, and before this they were evaluated in
   * the server's zone — UTC in a container, so a 06:00 rule fired at 09:00 in Israel. The browser
   * is the only thing that knows where they are, so the first authenticated load tells the server
   * once. Only when nothing is stored: a deliberate choice must never be overwritten by travelling.
   */
  adoptBrowserTimeZone(): void {
    this.load().subscribe({
      next: (u) => {
        if (u.timezone) return;
        this.setTimezone(browserTimeZone()).subscribe({ error: () => undefined });
      },
      error: () => undefined,
    });
  }
}
