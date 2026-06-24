import { usersRepository } from '../dal/user.repository';
import { JwtPurpose, jwtService } from './jwt.service';

export class RegisterService {
  async register(username: string, email: string, password: string, termsAccepted: boolean) {
    if (!termsAccepted) {
      throw Object.assign(new Error('You must accept the Terms of Service to register'), { statusCode: 400 });
    }

    if (!username || username.trim().length < 3) {
      throw Object.assign(new Error('Username must be at least 3 characters'), { statusCode: 400 });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw Object.assign(new Error('A valid email address is required'), { statusCode: 400 });
    }

    if (!password || password.length < 8) {
      throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 });
    }

    const existingByUsername = await usersRepository.findByUsername(username);
    if (existingByUsername) {
      throw Object.assign(new Error('Username is already taken'), { statusCode: 409 });
    }

    const existingByEmail = await usersRepository.findByEmail(email);
    if (existingByEmail) {
      throw Object.assign(new Error('Email is already registered'), { statusCode: 409 });
    }

    const user = await usersRepository.createRegularUser('user', username, password, email, new Date());

    const payload = {
      id: user.id,
      username: user.user_name,
      role: user.user_role,
      email: user.email,
      user_type: user.user_type,
      profileImage: user.profile_picture_url,
    };
    const token = jwtService.generateToken(payload, JwtPurpose.app_usage);
    return { token };
  }
}

export const registerService = new RegisterService();
