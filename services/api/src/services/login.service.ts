import type { User } from '@lattice/prisma-client';
import { db } from '../db';
import { JwtPurpose, jwtService } from './jwt.service';
import { usersService, toPublicUser, PublicUser } from './users.service';
import { googleService } from './google.service';

export interface AuthResult {
  token: string;
  refreshToken: string;
  user: PublicUser;
}

// Module-level token issuance so the verification flow (F15.8) can mint an auth result on
// successful email confirmation without reaching into LoginService's privates.
function issueToken(user: User, purpose: JwtPurpose): string {
  // Keep `id` in the claim — socket-server and other verifiers read `decoded.id`.
  return jwtService.generateToken(
    {
      id: user.id,
      username: user.user_name ?? user.full_name ?? user.email,
      role: user.user_role,
      email: user.email,
      user_type: user.user_type,
      profileImage: user.profile_picture_url,
    },
    purpose,
  );
}

export function issueAuthResult(user: User): AuthResult {
  return {
    token: issueToken(user, JwtPurpose.app_usage),
    refreshToken: issueToken(user, JwtPurpose.app_usage_refresh),
    user: toPublicUser(user),
  };
}

class LoginService {
  private issue(user: User, purpose: JwtPurpose): string {
    return issueToken(user, purpose);
  }

  private issueRefresh(user: User): string {
    return jwtService.generateToken({ id: user.id }, JwtPurpose.app_usage_refresh);
  }

  private async recordLogin(userId: number, ipAddress: string): Promise<void> {
    await db.userLoginAudit.create({ data: { user_id: userId, ip_address: ipAddress } });
  }

  async loginWithCredentials(
    username: string,
    password: string,
    ipAddress: string,
  ): Promise<AuthResult | null> {
    const user = await usersService.validateUser(username, password);
    if (!user) return null;
    // Gate: credential accounts must confirm their email first (F15.8). Signal a distinct 403
    // so the UI can offer to resend the verification email. Google accounts are always verified.
    if (!user.email_verified) {
      throw Object.assign(new Error('email_not_verified'), { statusCode: 403, email: user.email });
    }
    await this.recordLogin(user.id, ipAddress);
    return {
      token: this.issue(user, JwtPurpose.app_usage),
      refreshToken: this.issueRefresh(user),
      user: toPublicUser(user),
    };
  }

  async loginWithGoogle(
    code: string,
    ipAddress: string,
    termsAccepted: boolean,
  ): Promise<AuthResult | null> {
    const profile = await googleService.getUserFromCode(code);

    let user = await usersService.findByGoogleId(profile.sub);
    if (!user) {
      if (!termsAccepted) {
        throw Object.assign(
          new Error('You must accept the Terms of Service to create an account'),
          { statusCode: 403 },
        );
      }
      const existing = await usersService.findByEmail(profile.email);
      if (existing) {
        // Only an unclaimed placeholder (no password, no google_id) — e.g. the seeded owner — may
        // be linked. Auto-linking a credential/already-linked account would be an account-takeover
        // vector, so anything else is a genuine collision.
        if (existing.password || existing.google_id) {
          throw Object.assign(new Error('Email already in use'), { statusCode: 409 });
        }
        user = await usersService.linkGoogleId(existing.id, profile);
      } else {
        user = await usersService.createGoogleUser(profile);
      }
    }

    await this.recordLogin(user.id, ipAddress);
    return {
      token: this.issue(user, JwtPurpose.app_usage),
      refreshToken: this.issueRefresh(user),
      user: toPublicUser(user),
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthResult | null> {
    const result = jwtService.verifyToken(refreshToken, JwtPurpose.app_usage_refresh);
    if (!result.valid || !result.decoded?.id) return null;
    const user = await usersService.getById(result.decoded.id);
    if (!user) return null;
    return {
      token: this.issue(user, JwtPurpose.app_usage),
      refreshToken: this.issueRefresh(user),
      user: toPublicUser(user),
    };
  }
}

export const loginService = new LoginService();
