import { OAuth2Client } from 'google-auth-library';
import config from '../config/env.config';

export class GoogleService {
  private client: OAuth2Client;

  constructor() {
    this.client = new OAuth2Client(
      config.googleSignIn.signInClientId,
      config.googleSignIn.signInClientSecret,
      'postmessage',
    );
  }

  async getUserFromCode(code: string) {
    const { tokens } = await this.client.getToken(code);
    this.client.setCredentials(tokens);

    const userInfoResponse = await this.client.request({
      url: 'https://www.googleapis.com/oauth2/v3/userinfo',
    });

    return userInfoResponse.data as { sub: string; email: string; name: string; picture: string };
  }
}
export const googleService = new GoogleService();
