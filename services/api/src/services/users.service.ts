import bcrypt from 'bcrypt';
import type { User } from '@lattice/prisma-client';
import { isValidTimeZone } from '@lattice/params';
import { db } from '../db';

const SALT_ROUNDS = 10;

export interface PublicUser {
  id: number;
  username: string | null;
  email: string;
  role: string;
  user_type: number;
  profileImage: string | null;
  /** IANA zone every schedule of theirs is read against. Null = never set; the server's own zone. */
  timezone: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.user_name ?? user.full_name,
    email: user.email,
    role: user.user_role,
    user_type: user.user_type,
    profileImage: user.profile_picture_url,
    timezone: user.timezone,
  };
}

class UsersService {
  getById(id: number): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  }

  findByUsername(username: string): Promise<User | null> {
    return db.user.findUnique({ where: { user_name: username } });
  }

  findByEmail(email: string): Promise<User | null> {
    return db.user.findUnique({ where: { email } });
  }

  findByGoogleId(googleId: string): Promise<User | null> {
    return db.user.findUnique({ where: { google_id: googleId } });
  }

  async validateUser(username: string, password: string): Promise<User | null> {
    const user = await this.findByUsername(username);
    if (user?.password && (await bcrypt.compare(password, user.password))) {
      return user;
    }
    return null;
  }

  createGoogleUser(profile: {
    sub: string;
    email: string;
    name: string;
    picture: string;
  }): Promise<User> {
    return db.user.create({
      data: {
        user_type: 1,
        user_role: 'user',
        google_id: profile.sub,
        email: profile.email,
        full_name: profile.name,
        profile_picture_url: profile.picture || '',
        terms_accepted_at: new Date(),
        // Google has already verified the address — no email confirmation needed.
        email_verified: true,
      },
    });
  }

  // Attach a Google identity to an existing row (the seeded owner placeholder). Preserves the
  // existing user_role/user_type — never downgrades the admin placeholder to a plain user.
  linkGoogleId(
    id: number,
    profile: { sub: string; email: string; name: string; picture: string },
  ): Promise<User> {
    return db.user.update({
      where: { id },
      data: {
        google_id: profile.sub,
        full_name: profile.name,
        profile_picture_url: profile.picture || '',
        terms_accepted_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  // Credential accounts are created UNVERIFIED with a single-use verification token; login is
  // gated until the address is confirmed (F15.8).
  async createRegularUser(
    username: string,
    email: string,
    password: string,
    emailVerificationToken: string,
  ): Promise<User> {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    return db.user.create({
      data: {
        user_type: 0,
        user_role: 'user',
        user_name: username,
        password: hashedPassword,
        email,
        terms_accepted_at: new Date(),
        email_verified: false,
        email_verification_token: emailVerificationToken,
      },
    });
  }

  hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  // ── Email verification (F15.8) ──
  findByVerificationToken(token: string): Promise<User | null> {
    return db.user.findUnique({ where: { email_verification_token: token } });
  }

  async markEmailVerified(id: number): Promise<User> {
    return db.user.update({
      where: { id },
      data: { email_verified: true, email_verification_token: null, updated_at: new Date() },
    });
  }

  async setVerificationToken(id: number, token: string): Promise<void> {
    await db.user.update({
      where: { id },
      data: { email_verification_token: token, updated_at: new Date() },
    });
  }

  // ── Password reset (F15.9) ──
  findByResetToken(token: string): Promise<User | null> {
    return db.user.findUnique({ where: { password_reset_token: token } });
  }

  async setPasswordResetToken(id: number, token: string, expires: Date): Promise<void> {
    await db.user.update({
      where: { id },
      data: {
        password_reset_token: token,
        password_reset_expires: expires,
        updated_at: new Date(),
      },
    });
  }

  async resetPassword(id: number, newPassword: string): Promise<void> {
    const hashedPassword = await this.hashPassword(newPassword);
    await db.user.update({
      where: { id },
      data: {
        password: hashedPassword,
        password_reset_token: null,
        password_reset_expires: null,
        updated_at: new Date(),
      },
    });
  }

  async listAll(): Promise<PublicUser[]> {
    const users = await db.user.findMany({ orderBy: { id: 'asc' } });
    return users.map(toPublicUser);
  }

  async getPublicById(id: number): Promise<PublicUser> {
    const user = await this.getById(id);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    return toPublicUser(user);
  }

  // Admin-editable fields only — never touches credentials or google identity.
  async updateUser(
    id: number,
    patch: { role?: string; user_type?: number; full_name?: string },
  ): Promise<PublicUser> {
    if (!(await this.getById(id))) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    const user = await db.user.update({
      where: { id },
      data: {
        user_role: patch.role,
        user_type: patch.user_type,
        full_name: patch.full_name,
        updated_at: new Date(),
      },
    });
    return toPublicUser(user);
  }

  /**
   * The zone this user's schedules mean (F11.11).
   *
   * Validated against the runtime's own zone table rather than a hand-written list: an unknown name
   * would silently fall back to the server's zone at evaluation time, which is exactly the bug this
   * column exists to fix — so it must not be storable. Null clears it back to the server's zone.
   */
  async setTimezone(id: number, timezone: string | null): Promise<PublicUser> {
    if (timezone !== null && !isValidTimeZone(timezone)) {
      throw Object.assign(new Error(`"${timezone}" is not a known IANA timezone`), {
        statusCode: 400,
      });
    }
    if (!(await this.getById(id))) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    const user = await db.user.update({
      where: { id },
      data: { timezone, updated_at: new Date() },
    });
    return toPublicUser(user);
  }

  async deleteUser(id: number): Promise<void> {
    if (!(await this.getById(id))) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    await db.user.delete({ where: { id } });
  }
}

export const usersService = new UsersService();
