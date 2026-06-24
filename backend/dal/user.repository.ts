import db from '../config/db';
import bcrypt from 'bcrypt';
import { User } from '@prisma/client';

export type UserEntity = User;

export class UsersRepository {
  async getById(id: number): Promise<UserEntity | null> {
    return await db.user.findUnique({
      where: { id }
    });
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    return await db.user.findUnique({
      where: { email }
    });
  }

  async findByGoogleId(googleId: string): Promise<UserEntity | null> {
    return await db.user.findUnique({
      where: { google_id: googleId }
    });
  }

  async findByUsername(username: string): Promise<UserEntity | null> {
    return await db.user.findUnique({
      where: { user_name: username }
    });
  }

  async createGoogleUser(userRole: string, googleId: string, email: string, fullName: string, profilePictureUrl: string, termsAcceptedAt: Date) {
    return await db.user.create({
      data: {
        user_type: 1,
        user_role: userRole,
        google_id: googleId,
        email: email,
        full_name: fullName,
        profile_picture_url: profilePictureUrl,
        terms_accepted_at: termsAcceptedAt
      }
    });
  }

  async createRegularUser(userRole: string, username: string, password: string, email: string, termsAcceptedAt: Date) {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    return await db.user.create({
      data: {
        user_type: 0,
        user_role: userRole,
        user_name: username,
        password: hashedPassword,
        email: email,
        terms_accepted_at: termsAcceptedAt
      }
    });
  }
}

export const usersRepository = new UsersRepository();
