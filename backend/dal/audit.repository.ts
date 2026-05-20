import db from '../config/db';

export class AuditRepository {
  async logLogin(userId: number, ipAddress: string) {
    await db.query('INSERT INTO user_login_audit (user_id, ip_address) VALUES ($1, $2)', [userId, ipAddress]);
  }
}

export const auditRepository = new AuditRepository();