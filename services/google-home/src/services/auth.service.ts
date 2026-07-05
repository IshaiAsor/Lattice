import { OAuth2Client } from 'google-auth-library';
import bcrypt from 'bcryptjs';
import { db } from '@lattice/prisma-client';
import config from '../config/env.config';

const googleOAuth = new OAuth2Client(
  config.google.signInClientId,
  config.google.signInClientSecret,
  'postmessage',
);

export const authService = {
  async validateUser(username: string, password: string) {
    const user = await db.user.findUnique({ where: { user_name: username } });
    if (!user?.password) return null;
    return (await bcrypt.compare(password, user.password)) ? user : null;
  },

  async loginWithGoogle(code: string) {
    const { tokens } = await googleOAuth.getToken(code);
    googleOAuth.setCredentials(tokens);
    const { data } = await googleOAuth.request<{
      sub: string;
      email: string;
      name: string;
      picture: string;
    }>({ url: 'https://www.googleapis.com/oauth2/v3/userinfo' });

    let user = await db.user.findUnique({ where: { google_id: data.sub } });
    if (!user) {
      if (await db.user.findUnique({ where: { email: data.email } }))
        throw new Error('Email already in use');
      user = await db.user.create({
        data: {
          user_type: 1,
          user_role: 'user',
          google_id: data.sub,
          email: data.email,
          full_name: data.name,
          profile_picture_url: data.picture ?? '',
        },
      });
    }
    return user;
  },
};
