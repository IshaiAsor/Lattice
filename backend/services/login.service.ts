import { OAuth2Client } from 'google-auth-library';
import { usersService } from './users.service';
import { userRepository } from '../dal/user.repository';
import { JwtPurpose, jwtService } from './jwt.service';
import config from '../config/env.config';
import db from '../config/db';

class LoginService {
  private tokenPayload(user: any) {
    return {
      id: user.id,
      username: user.user_name ?? user.full_name ?? user.email,
      role: user.role,
      email: user.email,
      user_type: user.user_type,
      profileImage: user.profile_picture_url,
    };
  }

  async loginWithGoogle(code: string, ip: string): Promise<string> {
    const client = new OAuth2Client(
      config.google.signInClientId,
      config.google.signInClientSecret,
      'postmessage',
    );

    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) throw Object.assign(new Error('No id_token in Google response'), { status: 400 });

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.google.signInClientId!,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) throw Object.assign(new Error('Invalid Google token payload'), { status: 400 });

    const { sub, email, name, picture } = payload;
    if (!email) throw Object.assign(new Error('Email not provided by Google'), { status: 400 });

    let user = await userRepository.findByGoogleId(sub);

    if (!user) {
      const existing = await userRepository.findByEmail(email);
      if (existing) {
        user = await db.user.update({ where: { id: existing.id }, data: { google_id: sub } });
      } else {
        user = await userRepository.createGoogleUser({ google_id: sub, email, full_name: name, profile_picture_url: picture });
      }
    }

    await userRepository.logLogin(user.id, ip);
    return jwtService.generateToken(this.tokenPayload(user), JwtPurpose.app_usage);
  }

  async loginWithCredentials(
    username: string,
    password: string,
    ip: string,
    purpose = JwtPurpose.app_usage,
  ): Promise<{ token: string; user: any } | undefined> {
    const user = await usersService.validateUser(username, password);
    if (!user) return undefined;
    await userRepository.logLogin(user.id, ip);
    return { token: jwtService.generateToken(this.tokenPayload(user), purpose), user };
  }
}

export const loginService = new LoginService();
