import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { usersService } from './users.service';
import { issueAuthResult, type AuthResult } from './login.service';
import { sendVerificationEmail, sendPasswordResetEmail } from './auth-notify';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_PASSWORD_LEN = 8;

// Email verification (F15.8) + password reset (F15.9). Both mint single-use tokens and lean on
// notification-service's email channel; neither leaks whether an account exists.
class AuthFlowsService {
  // Confirm the email → verify the account and log the user straight in.
  async verifyEmail(token: string): Promise<AuthResult> {
    if (!token) throw Object.assign(new Error('Missing token'), { statusCode: 400 });
    const user = await usersService.findByVerificationToken(token);
    if (!user) {
      throw Object.assign(new Error('Invalid or expired verification link'), { statusCode: 400 });
    }
    const verified = await usersService.markEmailVerified(user.id);
    await db.userLoginAudit.create({ data: { user_id: verified.id } });
    return issueAuthResult(verified);
  }

  // Regenerate + resend a verification email. 404 if no pending account, 409 if already verified.
  async resendVerification(email: string): Promise<void> {
    if (!email) throw Object.assign(new Error('Email is required'), { statusCode: 400 });
    const user = await usersService.findByEmail(email);
    if (!user || !user.password) {
      // No credential account with this address (Google-only accounts have no verification step).
      throw Object.assign(new Error('No pending registration for this email'), { statusCode: 404 });
    }
    if (user.email_verified) {
      throw Object.assign(new Error('Email is already verified'), { statusCode: 409 });
    }
    const token = randomUUID();
    await usersService.setVerificationToken(user.id, token);
    await sendVerificationEmail(user.id, user.user_name ?? user.email, token);
  }

  // Always resolves without revealing whether the account exists. Only credential accounts
  // (with a password) get a reset email; Google-only accounts are skipped silently.
  async forgotPassword(email: string): Promise<void> {
    if (!email) return;
    const user = await usersService.findByEmail(email);
    if (!user || !user.password) return;
    const token = randomUUID();
    await usersService.setPasswordResetToken(
      user.id,
      token,
      new Date(Date.now() + RESET_TOKEN_TTL_MS),
    );
    await sendPasswordResetEmail(user.id, user.user_name ?? user.email, token);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!token) throw Object.assign(new Error('Missing token'), { statusCode: 400 });
    if (!newPassword || newPassword.length < MIN_PASSWORD_LEN) {
      throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`), {
        statusCode: 400,
      });
    }
    const user = await usersService.findByResetToken(token);
    if (!user || !user.password_reset_expires || user.password_reset_expires < new Date()) {
      throw Object.assign(new Error('Invalid or expired reset link'), { statusCode: 400 });
    }
    await usersService.resetPassword(user.id, newPassword);
  }
}

export const authFlowsService = new AuthFlowsService();
