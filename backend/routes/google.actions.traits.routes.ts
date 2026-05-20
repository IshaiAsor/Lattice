import express, { Request, Response } from 'express';
import { googleActionsTraitsService } from '../services/google.actions.traits.service';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

router.get('/', async (req: Request, res: Response) => {
  const traits = await googleActionsTraitsService.getGoogleActionTraits();
  res.json(traits);
});

export default router;
