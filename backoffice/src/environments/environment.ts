export const environment = {
  production: true,
  apiUrl: '',           // empty → derived at runtime as api.{hostname} (`api` service)
  deviceGatewayUrl: '', // empty → derived at runtime as device.{hostname}
  socketUrl: '',        // empty → derived at runtime as socket.{hostname}
  googleHomeUrl: '',    // empty → same origin (ingress serves google-home at /api/google)
  // No googleClientId here: one image is promoted staging → prod, so it can't be baked in.
  // The UI reads it from GET /api/auth/config (see auth.service.ts).
};