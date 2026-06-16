const express = require('express');
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const tls = require('tls');

const app = express();
const port = process.env.PORT || 3000;
const firmwarePath = process.env.FIRMWARE_PATH || './firmware';

// --- MQTT Client Setup (Matching Web-App) ---
const mqttOptions = {
  host: process.env.MQTT_INTERNAL_HOST || 'emqx',
  port: parseInt(process.env.MQTT_PORT || '8883'),
  protocol: process.env.MQTT_CA_CERT_PATH ? 'mqtts' : 'mqtt',
  username: process.env.MQTT_APP_USERNAME,
  password: process.env.MQTT_APP_PASSWORD,
  rejectUnauthorized: process.env.MQTT_VALIDATE_CERT === 'true',
  servername: process.env.MQTT_SERVER_NAME,
  checkServerIdentity: (host, cert) => {
    if (process.env.MQTT_SERVER_NAME) {
      return tls.checkServerIdentity(process.env.MQTT_SERVER_NAME, cert);
    }
    return tls.checkServerIdentity(host, cert);
  },
  keepalive: 60,
  reconnectPeriod: 1000,
  clientId: `ota_manager_${Math.random().toString(16).slice(2, 8)}`,
};

if (process.env.MQTT_CA_CERT_PATH && fs.existsSync(process.env.MQTT_CA_CERT_PATH)) {
  console.log(`🔐 Loading custom CA cert from: ${process.env.MQTT_CA_CERT_PATH}`);
  mqttOptions.ca = fs.readFileSync(process.env.MQTT_CA_CERT_PATH);
}

// Ensure firmware directory exists
if (!fs.existsSync(firmwarePath)) {
  fs.mkdirSync(firmwarePath, { recursive: true });
}

// Multer setup for firmware uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const deviceType = req.body.deviceType || 'generic';
    const dir = path.join(firmwarePath, deviceType);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const version = req.body.version || 'latest';
    cb(null, `${version}.bin`);
  },
});
const upload = multer({ storage: storage });

const mqttClient = mqtt.connect(mqttOptions);

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT Broker');
  // Republish retained OTA messages for any firmware already in storage
  // (covers the case where the init container wrote files before this process started)
  try {
    const deviceDirs = fs
      .readdirSync(firmwarePath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const device of deviceDirs) {
      const metaFile = path.join(firmwarePath, device, 'latest.json');
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        const topic = `ota/updates/${device}`;
        mqttClient.publish(topic, JSON.stringify(meta), { qos: 1, retain: true });
        console.log(`📡 Republished retained OTA message for ${device} ${meta.version}`);
      }
    }
  } catch (err) {
    console.error('⚠️  Failed to republish firmware metadata:', err.message);
  }
});

// --- API Routes ---

// 1. Serve firmware binaries
app.use('/download', express.static(firmwarePath));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Parses "V1.2.3" → [1, 2, 3]. Returns null on bad format.
function parseSemver(v) {
  const s = (v || '').replace(/^[Vv]/, '');
  const parts = s.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return parts;
}

// Returns true when a > b (strictly higher version).
function isHigherVersion(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false; // equal
}

// 2. Metadata check
app.get('/check', (req, res) => {
  const { deviceType } = req.query;
  if (!deviceType) return res.status(400).send('Missing deviceType');

  const metaFile = path.join(firmwarePath, deviceType, 'latest.json');
  console.log(`🔍 Checking metadata for ${deviceType} at ${metaFile}`);

  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return res.json(meta);
  }
  res.status(404).send('No firmware found for this device type');
});

// 3. Trigger OTA (Admin/Automation)
app.post('/release', upload.single('firmware'), (req, res) => {
  const { deviceType, version, releaseNotes } = req.body;

  console.log(`📥 Received release request: type=${deviceType}, version=${version}`);

  if (!req.file || !deviceType || !version) {
    console.error('❌ Missing required fields in release request');
    return res.status(400).send('Missing file, deviceType, or version');
  }

  if (!parseSemver(version)) {
    return res
      .status(400)
      .send(`Invalid version format "${version}" — expected Vmajor.minor.patch`);
  }

  // Reject if the uploaded version is not strictly higher than what's already published.
  const metaPathCheck = path.join(firmwarePath, deviceType, 'latest.json');
  if (fs.existsSync(metaPathCheck)) {
    const existing = JSON.parse(fs.readFileSync(metaPathCheck, 'utf8'));
    if (!isHigherVersion(version, existing.version)) {
      console.warn(
        `⚠️  Rejected release: ${version} is not higher than current ${existing.version}`,
      );
      return res
        .status(409)
        .send(`Version ${version} is not higher than current release ${existing.version}`);
    }
  }

  const downloadUrl = `https://${req.get('host')}/download/${deviceType}/${version}.bin`;

  const releaseData = {
    version,
    deviceType,
    url: downloadUrl,
    releaseNotes,
    timestamp: new Date().toISOString(),
  };

  const targetDir = path.join(firmwarePath, deviceType);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Save as latest
  const metaPath = path.join(targetDir, 'latest.json');
  fs.writeFileSync(metaPath, JSON.stringify(releaseData, null, 2));

  // Broadcast to devices
  const topic = `ota/updates/${deviceType}`;
  mqttClient.publish(topic, JSON.stringify(releaseData), { qos: 1, retain: true });

  console.log(`🚀 Released version ${version} for ${deviceType}. Metadata saved to ${metaPath}`);
  res.json({ message: 'Release published', data: releaseData });
});

app.listen(port, () => {
  console.log(`📡 OTA Manager listening at http://localhost:${port}`);
});
