import express from 'express';
import { handleSync, handleQuery, handleExecute, handleGroupExecute } from '../services/smarthome.service';
import { jwtService, JwtPurpose } from '../services/jwt.service';
import { createLogger } from '@lattice/logger';

const log    = createLogger('google-home:webhook');
const router = express.Router();

// All Smart Home requests carry a Bearer token — verify before routing
function extractUserId(authHeader: string | undefined): number | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token  = authHeader.split(' ')[1];
  const result = jwtService.verifyToken(token, JwtPurpose.google_cloud_to_cloud_login);
  if (!result.valid) return null;
  return parseInt(result.decoded.id);
}

// POST /smarthome — single webhook for all Google Home intents
router.post('/', async (req, res) => {
  const userId = extractUserId(req.headers.authorization);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const body    = req.body as { requestId: string; inputs: { intent: string; payload?: any }[] };
  const intent  = body?.inputs?.[0]?.intent;
  const payload = body?.inputs?.[0]?.payload;

  log.info({ userId, intent }, 'smarthome intent');

  try {
    if (intent === 'action.devices.SYNC') {
      const syncPayload = await handleSync(userId);
      return res.json({ requestId: body.requestId, payload: syncPayload });
    }

    if (intent === 'action.devices.QUERY') {
      const deviceIds = (payload?.devices as { id: string }[]).map((d) => d.id);
      const states    = await handleQuery(userId, deviceIds);
      return res.json({ requestId: body.requestId, payload: { devices: states } });
    }

    if (intent === 'action.devices.EXECUTE') {
      const commands = payload?.commands ?? [];
      const results  = await handleExecute(userId, commands);
      return res.json({ requestId: body.requestId, payload: { commands: results } });
    }

    if (intent === 'action.devices.DISCONNECT') {
      log.info({ userId }, 'Google Home disconnected');
      return res.json({});
    }

    // Custom group control intent (all devices with a capability, e.g. all lights)
    if (intent === 'action.devices.GROUP_EXECUTE') {
      const { capability, command, params } = payload ?? {};
      const result = await handleGroupExecute(userId, capability, command, params ?? {});
      return res.json({ requestId: body.requestId, payload: { commands: [result] } });
    }

    res.status(400).json({ error: `Unknown intent: ${intent}` });
  } catch (err) {
    log.error(err, 'smarthome intent failed');
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
