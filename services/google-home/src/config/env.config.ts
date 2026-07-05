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
  google: {
    authClientId: process.env['GOOGLE_AUTH_CLIENT_ID'] ?? '',
    authClientSecret: process.env['GOOGLE_AUTH_CLIENT_SECRET'] ?? '',
    signInClientId: process.env['GOOGLE_SIGN_IN_CLIENT_ID'] ?? '',
    signInClientSecret: process.env['GOOGLE_SIGN_IN_CLIENT_SECRET'],
    serviceAccountKey: process.env['GOOGLE_SERVICE_ACCOUNT_KEY'],
  },
};

export default config;
