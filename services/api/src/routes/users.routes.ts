import { Router } from 'express';
import { requireAppToken, requireAdmin } from '../middlewares/auth.middleware';
import { usersService } from '../services/users.service';

export const usersRouter = Router();

usersRouter.use(requireAppToken);

// Current user's own profile.
usersRouter.get('/me', async (req, res, next) => {
  try {
    res.json(await usersService.getPublicById(req.user!.id));
  } catch (err) {
    next(err);
  }
});

// The zone this user's schedules are read against (F11.11). Their own, not an admin's — a wrong
// timezone silently shifts every rule and pipeline they own.
usersRouter.patch('/me/timezone', async (req, res, next) => {
  try {
    const { timezone } = (req.body ?? {}) as { timezone?: string | null };
    res.json(await usersService.setTimezone(req.user!.id, timezone ?? null));
  } catch (err) {
    next(err);
  }
});

// Admin user management.
usersRouter.get('/', requireAdmin, async (_req, res, next) => {
  try {
    res.json(await usersService.listAll());
  } catch (err) {
    next(err);
  }
});

usersRouter.get('/:id', requireAdmin, async (req, res, next) => {
  try {
    res.json(await usersService.getPublicById(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

usersRouter.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { role, user_type, full_name } = req.body ?? {};
    res.json(await usersService.updateUser(Number(req.params.id), { role, user_type, full_name }));
  } catch (err) {
    next(err);
  }
});

usersRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await usersService.deleteUser(Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
