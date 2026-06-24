import { usersRepository } from '../dal/user.repository';
import { googleService } from './google.service';

export class GoogleLoginService {
  async handleGoogleLogin(code: string, termsAccepted?: boolean) {
    const googleUser = await googleService.getUserFromCode(code);

    let user = await usersRepository.findByGoogleId(googleUser.sub);

    if (!user) {
      if (!termsAccepted) {
        throw new Error('You must accept the Terms of Service to create an account');
      }

      const existingEmailUser = await usersRepository.findByEmail(googleUser.email);

      if (existingEmailUser) {
        throw new Error('Email already in use');
      } else {
        user = await usersRepository.createGoogleUser(
          'user',
          googleUser.sub,
          googleUser.email,
          googleUser.name,
          googleUser.picture || '',
          new Date()
        );
      }
    }
    return user;
  }
}

export const googleLoginService = new GoogleLoginService();
