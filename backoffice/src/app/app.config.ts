import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes'; // Your routes file
import { authInterceptor } from './interceptors/auth.interceptor';
import { errorInterceptor } from './services/error.interceptor';
export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes), // This makes the routing logic work
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(
      withInterceptors([authInterceptor,errorInterceptor])
    ), 
  ]
};