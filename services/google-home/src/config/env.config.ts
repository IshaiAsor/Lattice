const config = {
  port: +(process.env['PORT'] ?? 3010),
  rabbitmqUrl: process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  valkeyUrl: process.env['VALKEY_URL'] ?? 'redis://localhost:6379',
  jwt: {
    secret: process.env['JWT_SECRET'] ?? '',
    googleCloudToCloudLoginExpiresIn: +(
      process.env['JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_EXPIRES_IN'] ?? 3600
    ),
    googleCloudToCloudLoginRefreshExpiresIn: +(
      process.env['JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_REFRESH'] ?? 0
    ),
  },
  // Where account linking sends the user to sign in. Empty → same origin as this service, which
  // is what deployed environments want (the ingress serves the backoffice at / and this service
  // at /api/google on one host). Set it for local dev, where the UI runs on its own port.
  backofficeUrl: process.env['BACKOFFICE_URL'] ?? '',
  google: {
    authClientId: process.env['GOOGLE_AUTH_CLIENT_ID'] ?? '',
    authClientSecret: process.env['GOOGLE_AUTH_CLIENT_SECRET'] ?? '',
    serviceAccountKey: process.env['GOOGLE_SERVICE_ACCOUNT_KEY'],
  },
};

export default config;
