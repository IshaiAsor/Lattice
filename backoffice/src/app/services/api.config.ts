import { environment } from 'src/environments/environment';

// Base URL for the `api` service. Empty env value → derived at runtime as
// api.{hostname} in prod (same pattern the UI uses for the device-gateway and
// socket-server subdomains).
export function apiUrl(): string {
  return (
    environment.apiUrl ||
    (environment.production ? `${window.location.protocol}//api.${window.location.hostname}` : 'http://localhost:3100')
  );
}

// Base URL for the `google-home` service (Google Home account linking). Deployed environments
// serve it under /api/google on this same host, so the empty value means "same origin"; locally
// it is a separate container port.
export function googleHomeUrl(): string {
  return environment.googleHomeUrl || (environment.production ? '' : 'http://localhost:3010');
}
