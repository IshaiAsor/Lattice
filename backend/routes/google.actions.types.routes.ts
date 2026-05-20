import express, { Request, Response } from 'express';
import { googleActionsTypesService } from '../services/google.actions.types.service';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

router.get('/', async (req: Request, res: Response) => {
  const types = await googleActionsTypesService.getGoogleActionTypes();
  res.json(types);
});

export default router;
