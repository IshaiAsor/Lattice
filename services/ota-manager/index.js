const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createLogger } = require('@lattice/logger');
const { connect, publish, RK } = require('@lattice/queue');

const log = createLogger('ota-manager');

const app = express();
const port = process.env.PORT || 3000;
const firmwarePath = process.env.FIRMWARE_PATH || './firmware';

// Behind the Traefik ingress — trust one proxy hop so the rate limiter sees real client IPs.
app.set('trust proxy', 1);

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  log.warn('JWT_SECRET is not set — device download/check requests will be rejected');
}

// This service never touches MQTT. Firmware distribution is GitOps/Kargo-driven: the init
// container's entrypoint.sh writes each device's latest.json into the shared volume; on startup
// we announce those releases onto RabbitMQ (q.ota.incoming). digest-service validates/audits and
// forwards q.ota.dispatch → mqtt-service, the sole MQTT owner, which publishes the retained
// ota/updates/<deviceType> notification. The HTTP side is read-only (serve + metadata only).

// Devices authenticate firmware downloads with their own `device_usage` JWT
// (Bearer header, or `?token=` for the static download path).
function requireDeviceToken(req, res, next) {
  if (!JWT_SECRET) return res.sendStatus(503);
  const token =
    (req.headers.authorization && req.headers.authorization.split(' ')[1]) ||
    req.query.token;
  if (!token) return res.sendStatus(401);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.purpose !== 'device_usage') return res.sendStatus(403);
    req.device = decoded;
    return next();
  } catch (err) {
    return res.sendStatus(403);
  }
}

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });

app.use(globalLimiter);

// Ensure firmware directory exists
if (!fs.existsSync(firmwarePath)) {
  fs.mkdirSync(firmwarePath, { recursive: true });
}

// Announce every firmware currently in storage onto the OTA queue. The payloads in latest.json
// already match OtaIncomingPayload ({ deviceType, version, url, releaseNotes, timestamp }).
async function announceFirmware() {
  const ch = await connect();
  const deviceDirs = fs
    .readdirSync(firmwarePath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const device of deviceDirs) {
    const metaFile = path.join(firmwarePath, device, 'latest.json');
    if (!fs.existsSync(metaFile)) continue;
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    publish(ch, RK.OTA_INCOMING, meta);
    log.info({ deviceType: device, version: meta.version }, 'Announced OTA release → q.ota.incoming');
  }
}

// Best-effort with retry; never blocks the HTTP server from serving downloads.
async function announceWithRetry(attempt = 1) {
  try {
    await announceFirmware();
  } catch (err) {
    const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    log.error({ err, attempt, retryInMs: delay }, 'Failed to announce firmware to RabbitMQ — retrying');
    setTimeout(() => announceWithRetry(attempt + 1), delay);
  }
}

// --- API Routes ---

// 1. Serve firmware binaries (device-authenticated)
app.use('/download', requireDeviceToken, express.static(firmwarePath));

// 2. Metadata check (device-authenticated)
app.get('/check', requireDeviceToken, (req, res) => {
  const { deviceType } = req.query;
  if (!deviceType) return res.status(400).send('Missing deviceType');

  const metaFile = path.join(firmwarePath, deviceType, 'latest.json');
  log.debug({ deviceType, metaFile }, 'Checking firmware metadata');

  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return res.json(meta);
  }
  res.status(404).send('No firmware found for this device type');
});

app.listen(port, () => {
  log.info({ port }, 'OTA Manager listening');
  announceWithRetry();
});
