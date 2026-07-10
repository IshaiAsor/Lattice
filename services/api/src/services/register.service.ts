import { randomUUID } from 'node:crypto';
import { usersService } from './users.service';
import { sendVerificationEmail } from './auth-notify';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class RegisterService {
  // Self-service registration (F15.8): create the account UNVERIFIED and email a confirmation
  // link instead of issuing a JWT. The user lands in the app only after clicking the link
  // (GET /verify-email) — so a mistyped/unowned address can't get a working session.
  async register(
    username: string,
    email: string,
    password: string,
    termsAccepted: boolean,
  ): Promise<{ pendingVerification: true }> {
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

    const token = randomUUID();
    const user = await usersService.createRegularUser(username, email, password, token);
    await sendVerificationEmail(user.id, username, token);
    return { pendingVerification: true };
  }
}

export const registerService = new RegisterService();
