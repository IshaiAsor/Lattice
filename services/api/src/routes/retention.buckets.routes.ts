import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { retentionTiersService } from '../services/retention-tiers.service';

// The shared bucket vocabulary (F18.9).
//
// Any signed-in user may read it AND add to it: a bucket size is a unit, not personal data, and two
// people who both want 90 minutes want the same 5400 seconds. What stays private is which buckets
// you keep and for how long — that is the tier list, in retention.routes.ts.

/** Mounted at /api/retention/buckets — the shared bucket vocabulary. */
export const retentionBucketsRouter = Router();
retentionBucketsRouter.use(requireAppToken);

retentionBucketsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await retentionTiersService.listBuckets());
  } catch (err) {
    next(err);
  }
});

// Any user may add a size — a bucket is a unit, not personal data, and two people who both want 90
// minutes want the same 5400 seconds. A duplicate resolves to the existing row rather than erroring.
retentionBucketsRouter.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await retentionTiersService.createBucket(req.user!.id, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

// No PATCH of `seconds` exists, deliberately: rows already aggregated at the old width would be
// silently reinterpreted. The route does not exist rather than existing and refusing.
retentionBucketsRouter.delete('/:code', async (req, res, next) => {
  try {
    await retentionTiersService.deleteBucket(
      req.user!.id,
      req.user!.role === 'admin',
      req.params.code,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
