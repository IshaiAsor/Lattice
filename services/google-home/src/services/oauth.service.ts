import crypto from 'crypto';
import { valkeyService } from './valkey.service';

// A pending Google account-linking request, parked while the user signs in on the backoffice.
export interface LinkRequest {
  redirectUri: string;
  state: string;
  clientId: string;
}

const REQUEST_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 600;

export const oauthService = {
  // Park the OAuth params from Google under an opaque id. Only the id travels through the
  // browser, so redirect_uri/state can't be tampered with between /auth and /auth/authorize.
  async createLinkRequest(request: LinkRequest): Promise<string> {
    const requestId = crypto.randomBytes(16).toString('hex');
    await valkeyService.set(`oauth_req:${requestId}`, request, REQUEST_TTL_SECONDS);
    return requestId;
  },

  // Trade a pending request (plus the now-authenticated user) for the Google redirect that
  // carries the authorization code. Returns null when the request is unknown or expired.
  async authorize(requestId: string, userId: number): Promise<string | null> {
    const request = await valkeyService.get<LinkRequest>(`oauth_req:${requestId}`);
    if (!request) return null;
    // Single use: the id is spent whether or not the rest succeeds.
    await valkeyService.del(`oauth_req:${requestId}`);

    const authCode = crypto.randomBytes(16).toString('hex');
    await valkeyService.set(
      `oauth_code:${authCode}`,
      { userId, redirectUri: request.redirectUri },
      CODE_TTL_SECONDS,
    );

    const url = new URL(request.redirectUri);
    url.searchParams.set('code', authCode);
    url.searchParams.set('state', request.state);
    return url.toString();
  },
};
