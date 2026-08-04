import { HttpErrorResponse, HttpEvent, HttpInterceptorFn, HttpRequest, HttpHandlerFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { BehaviorSubject, Observable, throwError } from 'rxjs';
import { catchError, filter, switchMap, take } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';
import { MatSnackBar } from '@angular/material/snack-bar';

let isRefreshing = false;
const refreshDone$ = new BehaviorSubject<string | null>(null);

function withBearerToken(req: HttpRequest<unknown>, token: string): HttpRequest<unknown> {
  return req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}

function handleRefresh(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
  authService: AuthService,
): Observable<HttpEvent<unknown>> {
  if (!isRefreshing) {
    isRefreshing = true;
    refreshDone$.next(null);

    return authService.refreshAccessToken().pipe(
      switchMap((response) => {
        isRefreshing = false;
        refreshDone$.next(response.token);
        return next(withBearerToken(req, response.token));
      }),
      catchError((err) => {
        isRefreshing = false;
        authService.logout();
        return throwError(() => err);
      }),
    );
  }

  // Another refresh is in flight — wait for it to complete then retry.
  return refreshDone$.pipe(
    filter((token): token is string => token !== null),
    take(1),
    switchMap((token) => next(withBearerToken(req, token))),
  );
}

// Public auth endpoints never carry a session token, so a 401 from them is a real
// credential/verification failure — not an expired-session signal. Attempting a refresh here
// clobbers the actual error (e.g. "Invalid credentials") with an unrelated refresh-token failure.
const PUBLIC_AUTH_PATHS = [
  '/api/auth/config',
  '/api/auth/login',
  '/api/auth/google',
  '/api/auth/register',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/refresh-token',
];

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const snackBar = inject(MatSnackBar);

  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401) {
        if (PUBLIC_AUTH_PATHS.some((path) => req.url.includes(path))) {
          // A rejected refresh token is handled by whoever asked for the refresh: handleRefresh
          // below logs out mid-session, and AuthService.restoreSession() owns it at bootstrap
          // (where logging out here would race the router's initial navigation).
          return throwError(() => error);
        }
        return handleRefresh(req, next, authService);
      }
      snackBar.open(`Error occured , error code : ${error.status}, error message : ${error.message}`, 'close', { duration: 2000 });
      return throwError(() => error);
    }),
  );
};
