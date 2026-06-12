import db from '../config/db';
import { SensorReading } from '@lattice/prisma-client';

class SensorHistoryRepository {
  async insert(userActionId: number, value: string): Promise<void> {
    await db.sensorReading.create({ data: { user_action_id: userActionId, value } });
  }

  async getRecentForUser(userId: number, hoursBack: number): Promise<SensorReading[]> {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    return db.sensorReading.findMany({
      where: {
        recorded_at: { gte: since },
        user_action: { user_device: { user_id: userId } },
      },
      include: { user_action: { select: { name: true } } },
      orderBy: { recorded_at: 'asc' },
    }) as Promise<SensorReading[]>;
  }

  async pruneOlderThan(days: number): Promise<void> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await db.sensorReading.deleteMany({ where: { recorded_at: { lt: cutoff } } });
  }
}

export const sensorHistoryRepository = new SensorHistoryRepository();
