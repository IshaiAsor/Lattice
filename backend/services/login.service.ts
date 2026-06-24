import { usersService } from './users.service';
import { googleLoginService } from './google.users.service';
import { auditRepository } from '../dal/audit.repository';
import { JwtPurpose, jwtService } from './jwt.service';

export class LoginService {
  private generateAuthResponse(user: any, purpose: JwtPurpose): string {
    let payload = {
      id: user.id,
      username: user.user_name || user.full_name || user.email,
      role: user.user_role,
      email: user.email,
      user_type: user.user_type,
      profileImage: user.profile_picture_url,
    };
    return jwtService.generateToken(payload, purpose);
  }

  async loginWithCredentials(
    username: string,
    password: string,
    ipAddress: string,
    purpose: JwtPurpose,
  ): Promise<{ token: string; user: any } | undefined> {
    const user = await usersService.validateUser(username, password);
    if (user) {
      await auditRepository.logLogin(user.id, ipAddress);

      let token = this.generateAuthResponse(user, purpose);
      return { token: token, user: user };
    }
    return undefined;
  }

  async loginWithGoogle(
    code: string,
    ipAddress: string,
    purpose: JwtPurpose,
    termsAccepted?: boolean,
  ): Promise<{ token: string; user: any } | undefined> {
    const user = await googleLoginService.handleGoogleLogin(code, termsAccepted);
    if (user) {
      await auditRepository.logLogin(user.id, ipAddress);
      let token = this.generateAuthResponse(user, purpose);
      return { token: token, user: user };
    }
    return undefined;
  }
}

export const loginService = new LoginService();
