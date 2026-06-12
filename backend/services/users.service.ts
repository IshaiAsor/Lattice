import { userRepository } from '../dal/user.repository';
import bcrypt from 'bcrypt';

class UsersService {
  async getUserInfo(userId: number) {
    const user = await userRepository.getById(userId);
    if (!user) throw new Error('User not found');
    return {
      username: user.full_name,
      email: user.email,
      role: user.role,
      user_type: user.user_type,
      profileImage: user.profile_picture_url,
    };
  }

  async validateUser(username: string, password: string) {
    const user = await userRepository.findByUsername(username);
    if (user?.password && await bcrypt.compare(password, user.password)) return user;
    return null;
  }
}

export const usersService = new UsersService();
