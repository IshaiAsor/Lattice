import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { notificationsService, type PreferenceInput } from '../services/notifications.service';
import {
  pushSubscriptionService,
  type PushSubscribeInput,
} from '../services/push-subscription.service';

export const notificationsRouter = Router();

notificationsRouter.use(requireAppToken);

// Preference matrix (effective enabled + default/explicit + locked) for the settings page.
notificationsRouter.get('/preferences', async (req, res, next) => {
  try {
    res.json(await notificationsService.getPreferences(req.user!.id));
  } catch (err) {
    next(err);
  }
});

// Bulk upsert. Body: { preferences: [{channel, event_type, enabled}] } or a bare array.
notificationsRouter.put('/preferences', async (req, res, next) => {
  try {
    const body = req.body as { preferences?: PreferenceInput[] } | PreferenceInput[];
    const items = Array.isArray(body) ? body : (body?.preferences ?? []);
    await notificationsService.setPreferences(req.user!.id, items);
    res.json(await notificationsService.getPreferences(req.user!.id));
  } catch (err) {
    next(err);
  }
});

// Inbox list, newest first. ?limit= (≤100), ?before= (id cursor for pagination).
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const limit = Number(req.query['limit'] ?? 30);
    const before = req.query['before'] ? Number(req.query['before']) : undefined;
    res.json(
      await notificationsService.listHistory(
        req.user!.id,
        isNaN(limit) ? 30 : limit,
        before && !isNaN(before) ? before : undefined,
      ),
    );
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/unread-count', async (req, res, next) => {
  try {
    res.json({ count: await notificationsService.unreadCount(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    await notificationsService.markAllRead(req.user!.id);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/:id/read', async (req, res, next) => {
  try {
    await notificationsService.markRead(req.user!.id, Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// Web-push (VAPID) subscription capture — the browser fetches the public key, subscribes via
// the Push API, then registers the resulting subscription here.
notificationsRouter.get('/push/public-key', async (req, res, next) => {
  try {
    res.json({ publicKey: pushSubscriptionService.getPublicKey() });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/push/subscribe', async (req, res, next) => {
  try {
    const body = req.body as PushSubscribeInput;
    await pushSubscriptionService.subscribe(req.user!.id, body, req.headers['user-agent']);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

notificationsRouter.delete('/push/subscribe', async (req, res, next) => {
  try {
    const endpoint = (req.body?.endpoint ?? req.query['endpoint']) as string;
    await pushSubscriptionService.unsubscribe(req.user!.id, endpoint);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
