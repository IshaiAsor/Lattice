export const config = {
  port:      +(process.env.PORT ?? 3003),
  jwtSecret:   process.env.JWT_SECRET ?? '',

  jwt: {
    appUsageExpiresIn:                       +(process.env.JWT_APP_USAGE_EXPIRES_IN                    ?? 0),
    appUsageRefreshExpiresIn:                +(process.env.JWT_APP_USAGE_REFRESH_EXPIRES_IN             ?? 0),
    googleCloudToCloudLoginExpiresIn:        +(process.env.JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_EXPIRES_IN   ?? 3600),
    googleCloudToCloudLoginRefreshExpiresIn: +(process.env.JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_REFRESH      ?? 604800),
  },

  google: {
    authClientId:       process.env.GOOGLE_AUTH_CLIENT_ID       ?? '',
    authClientSecret:   process.env.GOOGLE_AUTH_CLIENT_SECRET   ?? '',
    signInClientId:     process.env.GOOGLE_SIGN_IN_CLIENT_ID    ?? '',
    signInClientSecret: process.env.GOOGLE_SIGN_IN_CLIENT_SECRET ?? '',
    homegraphKeyFile:   process.env.GOOGLE_HOMEGRAPH_KEY_FILE   ?? '',
  },

  valkey: {
    url:      process.env.VALKEY_URL      ?? 'redis://localhost:6379',
    username: process.env.VALKEY_USER,
    password: process.env.VALKEY_PASSWORD,
  },

  rateLimit: {
    windowMs: +(process.env.RATE_LIMIT_WINDOW_MS   ?? 15 * 60 * 1000),
    limit:    +(process.env.RATE_LIMIT_MAX_REQUESTS ?? 150),
  },
};

export default config;
