import { JwtPurpose, jwtService } from './jwt.service';
import { usersService, toPublicUser, PublicUser } from './users.service';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class RegisterService {
  async register(
    username: string,
    email: string,
    password: string,
    termsAccepted: boolean,
  ): Promise<{ token: string; refreshToken: string; user: PublicUser }> {
    if (!termsAccepted) {
      throw Object.assign(new Error('You must accept the Terms of Service to register'), {
        statusCode: 400,
      });
    }
    if (!username || username.trim().length < 3) {
      throw Object.assign(new Error('Username must be at least 3 characters'), { statusCode: 400 });
    }
    if (!email || !EMAIL_RE.test(email)) {
      throw Object.assign(new Error('A valid email address is required'), { statusCode: 400 });
    }
    if (!password || password.length < 8) {
      throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 });
    }

    if (await usersService.findByUsername(username)) {
      throw Object.assign(new Error('Username is already taken'), { statusCode: 409 });
    }
    if (await usersService.findByEmail(email)) {
      throw Object.assign(new Error('Email is already registered'), { statusCode: 409 });
    }

    const user = await usersService.createRegularUser(username, email, password);
    const token = jwtService.generateToken(
      {
        id: user.id,
        username: user.user_name,
        role: user.user_role,
        email: user.email,
        user_type: user.user_type,
      },
      JwtPurpose.app_usage,
    );
    const refreshToken = jwtService.generateToken({ id: user.id }, JwtPurpose.app_usage_refresh);
    return { token, refreshToken, user: toPublicUser(user) };
  }
}

export const registerService = new RegisterService();
