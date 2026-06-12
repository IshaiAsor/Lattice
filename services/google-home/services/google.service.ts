import { OAuth2Client } from 'google-auth-library';
import config from '../config/env.config';

class GoogleService {
  private client: OAuth2Client;

  constructor() {
    this.client = new OAuth2Client(
      config.google.signInClientId,
      config.google.signInClientSecret,
      'postmessage',
    );
  }

  async getUserFromCode(code: string): Promise<{ sub: string; email: string; name: string; picture: string }> {
    const { tokens } = await this.client.getToken(code);
    this.client.setCredentials(tokens);
    const res = await this.client.request({ url: 'https://www.googleapis.com/oauth2/v3/userinfo' });
    return res.data as { sub: string; email: string; name: string; picture: string };
  }
}

export const googleService = new GoogleService();
