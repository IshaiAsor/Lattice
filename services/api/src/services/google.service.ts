import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.config';

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

class GoogleService {
  private client: OAuth2Client;

  constructor() {
    // 'postmessage' redirect = the popup/auth-code flow the UI uses.
    this.client = new OAuth2Client(
      env.googleSignIn.clientId,
      env.googleSignIn.clientSecret,
      'postmessage',
    );
  }

  // The OAuth client id the browser must initialize its code client with. Public by design (it
  // travels in every OAuth request); only the paired secret stays server-side. Served to the UI
  // so a single backoffice image can run against staging and prod, each with its own client.
  publicClientId(): string {
    return env.googleSignIn.clientId;
  }

  async getUserFromCode(code: string): Promise<GoogleProfile> {
    const { tokens } = await this.client.getToken(code);
    this.client.setCredentials(tokens);

    const userInfoResponse = await this.client.request({
      url: 'https://www.googleapis.com/oauth2/v3/userinfo',
    });

    return userInfoResponse.data as GoogleProfile;
  }
}

export const googleService = new GoogleService();
