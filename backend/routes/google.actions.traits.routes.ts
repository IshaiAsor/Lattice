import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { catalogRepository } from '../dal/catalog.repository';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));

router.get('/', async (_req, res) => {
  res.json(await catalogRepository.listGoogleTraits());
});

export default router;
