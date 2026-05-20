import { usersRepository } from '../dal/user.repository';
import bcrypt from 'bcrypt';

export class UsersService {
  async GetUserInfo(userId: any) {

    const user = await usersRepository.getById(userId);
    return {
      username: user.full_name,
      email: user.email,
      role: user.user_role,
      user_type: user.user_type,
      profileImage: user.profile_picture_url,

    };
  }
  async validateUser(username: string, pass: string) {
    const user = await usersRepository.findByUsername(username);
    if (user && user.password) {
      const isMatch = await bcrypt.compare(pass, user.password);
      if (isMatch) {
        return user;
      }
    }
    return null;
  }
}

export const usersService = new UsersService();
