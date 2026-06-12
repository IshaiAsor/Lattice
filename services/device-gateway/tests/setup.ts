// Runs before any module is loaded — set env vars that config/env.config.ts reads.
process.env.JWT_SECRET        = 'test-secret-do-not-use-in-prod';
process.env.GATEWAY_BASE_URL  = 'http://localhost:3004';
process.env.MQTT_VALIDATE_CERT = 'false';
process.env.PORT              = '3004';
