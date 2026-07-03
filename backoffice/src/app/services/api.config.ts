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
