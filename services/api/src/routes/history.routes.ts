import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { historyService } from '../services/history.service';

// Read-only history (F18.2 / F18.7). Thin delegates: parse, call, shape. Every handler wraps its
// body in try/catch — Express 4 does not route a rejected promise to the error middleware, so a
// missing catch is a hung request, not a 500.

export const historyRouter = Router();

historyRouter.use(requireAppToken);

// Dashboard stat row.
historyRouter.get('/summary', async (req, res, next) => {
  try {
    res.json(await historyService.summary(req.user!.id, req.query));
  } catch (err) {
    next(err);
  }
});

// The whole-home command feed. Filterable by device/action/source/outcome; cursor-paginated.
historyRouter.get('/commands', async (req, res, next) => {
  try {
    res.json(await historyService.commands(req.user!.id, req.query));
  } catch (err) {
    next(err);
  }
});

// A reading series. ?bucket=auto|raw|hour|day — auto picks from the range width.
historyRouter.get('/actions/:id/series', async (req, res, next) => {
  try {
    res.json(await historyService.series(req.user!.id, Number(req.params.id), req.query));
  } catch (err) {
    next(err);
  }
});

// Frame metadata only — the images are fetched one at a time below.
historyRouter.get('/actions/:id/frames', async (req, res, next) => {
  try {
    res.json(await historyService.frames(req.user!.id, Number(req.params.id), req.query));
  } catch (err) {
    next(err);
  }
});

historyRouter.get('/frames/:id', async (req, res, next) => {
  try {
    res.json(await historyService.frame(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// A device's own timeline: online/offline, firmware, faults.
historyRouter.get('/devices/:id/events', async (req, res, next) => {
  try {
    res.json(await historyService.deviceEvents(req.user!.id, Number(req.params.id), req.query));
  } catch (err) {
    next(err);
  }
});

historyRouter.get('/devices/:id/availability', async (req, res, next) => {
  try {
    res.json(await historyService.availability(req.user!.id, Number(req.params.id), req.query));
  } catch (err) {
    next(err);
  }
});
