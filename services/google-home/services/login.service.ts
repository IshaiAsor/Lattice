import { db } from '@lattice/prisma-client';
import { googleService } from './google.service';
import { jwtService, JwtPurpose } from './jwt.service';
import bcrypt from 'bcrypt';

type LoginResult = { token: string; refreshToken: string; user: { id: number; email: string } };

function makeTokens(userId: number, purpose: JwtPurpose, refreshPurpose: JwtPurpose): { token: string; refreshToken: string } {
  const payload = { id: userId, user: 'google' };
  return {
    token:        jwtService.generateToken(payload, purpose),
    refreshToken: jwtService.generateToken(payload, refreshPurpose),
  };
}

export async function loginWithCredentials(username: string, password: string): Promise<LoginResult | null> {
  const user = await db.user.findUnique({ where: { user_name: username } });
  if (!user?.password) return null;
  if (!(await bcrypt.compare(password, user.password))) return null;
  const { token, refreshToken } = makeTokens(user.id, JwtPurpose.google_cloud_to_cloud_login, JwtPurpose.google_cloud_to_cloud_login_refresh);
  return { token, refreshToken, user: { id: user.id, email: user.email } };
}

export async function loginWithGoogle(code: string): Promise<LoginResult | null> {
  const googleUser = await googleService.getUserFromCode(code);
  let user = await db.user.findUnique({ where: { google_id: googleUser.sub } });
  if (!user) {
    const existing = await db.user.findUnique({ where: { email: googleUser.email } });
    if (existing) throw new Error('Email already in use');
    user = await db.user.create({
      data: { google_id: googleUser.sub, email: googleUser.email, full_name: googleUser.name, profile_picture_url: googleUser.picture },
    });
  }
  const { token, refreshToken } = makeTokens(user.id, JwtPurpose.google_cloud_to_cloud_login, JwtPurpose.google_cloud_to_cloud_login_refresh);
  return { token, refreshToken, user: { id: user.id, email: user.email } };
}
