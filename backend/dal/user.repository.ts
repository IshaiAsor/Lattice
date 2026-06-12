import db from '../config/db';
import { User } from '@lattice/prisma-client';

class UserRepository {
  async findByEmail(email: string): Promise<User | null> {
    return db.user.findUnique({ where: { email } });
  }

  async findByUsername(userName: string): Promise<User | null> {
    return db.user.findUnique({ where: { user_name: userName } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return db.user.findUnique({ where: { google_id: googleId } });
  }

  async getById(id: number): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  }

  async createGoogleUser(data: {
    google_id: string;
    email: string;
    full_name?: string | null;
    profile_picture_url?: string | null;
  }): Promise<User> {
    return db.user.create({ data });
  }

  async logLogin(userId: number, ipAddress?: string): Promise<void> {
    await db.userLoginAudit.create({ data: { user_id: userId, ip_address: ipAddress } });
  }
}

export const userRepository = new UserRepository();
