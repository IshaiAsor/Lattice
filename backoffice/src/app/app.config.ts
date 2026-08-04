import { ApplicationConfig, inject, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withHashLocation } from '@angular/router';
import { routes } from './app.routes'; // Your routes file
import { authInterceptor } from './interceptors/auth.interceptor';
import { errorInterceptor } from './services/error.interceptor';
import { AuthService } from './services/auth.service';
export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withHashLocation()), // Enable hash routing
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(
      withInterceptors([authInterceptor,errorInterceptor])
    ),
    // Settle the session before the router's first navigation: a returning user whose access token
    // has expired still holds a far longer-lived refresh token, and exchanging it here is what
    // keeps them from being sent to /login on every visit. Bootstrap blocks on this promise.
    provideAppInitializer(() => inject(AuthService).restoreSession()),
  ]
};