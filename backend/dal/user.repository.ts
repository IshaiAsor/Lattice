import db from '../config/db';
import bcrypt from 'bcrypt';
export interface UserEntity {
  id: number;
  user_type: number;
  user_role: string;
  user_name: string;
  password: string;
  google_id: string;
  email: string;
  full_name: string;
  profile_picture_url: string;
  created_at: Date;
  updated_at: Date;
}
export class UsersRepository {
  async getById(id: number): Promise<UserEntity> {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0];
  }

  async findByEmail(email: string): Promise<UserEntity> {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return result.rows[0];
  }

  async findByGoogleId(googleId: string): Promise<UserEntity> {
    const result = await db.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    return result.rows[0];
  }

  async findByUsername(username: string): Promise<UserEntity> {
    const result = await db.query('SELECT * FROM users WHERE user_name = $1', [username]);
    return result.rows[0];
  }

  async createGoogleUser(userRole: string, googleId: string, email: string, fullName: string, profilePictureUrl: string) {
    const result = await db.query(
      `INSERT INTO users (user_type, user_role, google_id, email, full_name, profile_picture_url) 
       VALUES (1, $1, $2, $3, $4, $5) RETURNING *`,
      [userRole, googleId, email, fullName, profilePictureUrl]
    );
    return result.rows[0];
  }

  async createRegularUser(userRole: string, username: string, password: string, email: string) {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const result = await db.query(
      `INSERT INTO users (user_type, user_role, user_name, password, email) 
     VALUES (0, $1, $2, $3, $4) RETURNING *`,
      [userRole, username, hashedPassword, email]
    );
    return result.rows[0];
  }
}

export const usersRepository = new UsersRepository();