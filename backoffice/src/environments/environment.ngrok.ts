// Opt-in environment for the Google Home account-linking regression test ONLY.
// Used via `ng serve --configuration=ngrok` (see angular.json). Normal dev keeps using
// environment.development.ts (plain localhost) — this file exists so the everyday `ng serve`
// is never forced through Caddy/ngrok.
//
// The linking flow bounces the phone through the public ngrok URL, so the backoffice's own
// api + google-home calls must be same-origin; Caddy fronts all three on that one origin.
export const environment = {
  production: false,
  apiUrl: 'https://dividual-leigha-tensible.ngrok-free.dev', // `api` via Caddy
  deviceGatewayUrl: 'http://localhost:3004',
  socketUrl: 'http://localhost:3007',
  googleHomeUrl: 'https://dividual-leigha-tensible.ngrok-free.dev', // google-home via Caddy
  // googleClientId comes from GET /api/auth/config — see environment.ts.
};
