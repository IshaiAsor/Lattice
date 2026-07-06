import bcrypt from 'bcrypt';
import type { User } from '@lattice/prisma-client';
import { db } from '../db';

const SALT_ROUNDS = 10;

export interface PublicUser {
  id: number;
  username: string | null;
  email: string;
  role: string;
  user_type: number;
  profileImage: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.user_name ?? user.full_name,
    email: user.email,
    role: user.user_role,
    user_type: user.user_type,
    profileImage: user.profile_picture_url,
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

  async createRegularUser(username: string, email: string, password: string): Promise<User> {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    return db.user.create({
      data: {
        user_type: 0,
        user_role: 'user',
        user_name: username,
        password: hashedPassword,
        email,
        terms_accepted_at: new Date(),
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

  async deleteUser(id: number): Promise<void> {
    if (!(await this.getById(id))) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    await db.user.delete({ where: { id } });
  }
}

export const usersService = new UsersService();
