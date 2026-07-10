// Shared Prisma client. notification-service is a read-only consumer of user data (prefs,
// email, push subscriptions) + writer of its own notification_history rows; it never mutates
// users/devices/actions (api owns those).
export { db, Prisma } from '@lattice/prisma-client';
