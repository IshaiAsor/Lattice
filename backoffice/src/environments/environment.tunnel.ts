// Opt-in environment for serving this app through the frp tunnel, on a public HTTPS origin.
// Used via `ng serve --configuration=tunnel` (see angular.json). Normal dev keeps using
// environment.development.ts (plain localhost) — this exists so the everyday `ng serve` is never
// forced through the tunnel.
//
// Everything must be SAME-ORIGIN. The page is served from https://lattice-local.duckdns.org, so
// calling http://localhost:3100 gets blocked twice over: CORS (the allowlist is a literal match on
// localhost:4200) and mixed content (https page, http request). frp fronts api, google-home and
// socket-server on that one origin by path, exactly as the prod/staging ingress does.
//
// Replaces the old environment.ngrok.ts — ngrok's free tier injected a browser interstitial that
// whitescreened the Google Home webview (F7.11).
export const environment = {
  production: false,
  apiUrl: 'https://lattice-local.duckdns.org', // `api` via frp locations ["/api"]
  googleHomeUrl: 'https://lattice-local.duckdns.org', // `google-home` via ["/api/google"]
  socketUrl: 'https://lattice-local.duckdns.org', // `socket-server` via ["/socket.io"]
  // device-gateway gets its own host so real hardware can reach it without a LAN route.
  deviceGatewayUrl: 'https://device.lattice-local.duckdns.org',
  // googleClientId comes from GET /api/auth/config — see environment.ts.
};
