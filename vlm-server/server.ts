import express from 'express';
import type { Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { OnnxAdapter } from './adapters/onnx.adapter.ts';
import { HttpAdapter } from './adapters/http.adapter.ts';
import type { IVisionAdapter, VisionDetection } from './adapters/interface.ts';
import { components } from './swagger.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

// --- Default ONNX adapter (lettuce model, backwards compat) ---
const lettuceClasses = JSON.parse(
  readFileSync(path.join(__dirname, 'models', 'lettuce', 'classes.json'), 'utf8')
) as string[];

const defaultAdapter = new OnnxAdapter(
  path.join(__dirname, 'models', 'lettuce', 'model.onnx'),
  lettuceClasses,
);

app.use(express.json());
app.use(express.raw({ type: 'image/jpeg', limit: '10mb' }));

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'VLM Server',
      version: '2.0.0',
      description: `Generic vision model inference server.

**v1** (backwards compatible): raw JPEG → ONNX lettuce model → detections + farm action
**v2** (generic): \`{ type, config, image }\` → adapter → normalized detections`,
    },
    components,
  },
  apis: [fileURLToPath(import.meta.url)],
});

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// --- Helpers ---

function aggregateDetections(detections: VisionDetection[]): AggregatedDetection[] {
  const map = new Map<string, { count: number; maxConfidence: number; boxes: VisionDetection['box'][] }>();
  for (const d of detections) {
    const entry = map.get(d.className) ?? { count: 0, maxConfidence: 0, boxes: [] };
    entry.count++;
    entry.maxConfidence = Math.max(entry.maxConfidence, d.confidence);
    entry.boxes.push(d.box);
    map.set(d.className, entry);
  }
  return Array.from(map.entries()).map(([className, v]) => ({
    className,
    count: v.count,
    confidence: v.maxConfidence,
    boxes: v.boxes,
  }));
}

interface AggregatedDetection {
  className: string;
  count: number;
  confidence: number;
  boxes: VisionDetection['box'][];
}

// --- Routes ---

/**
 * @openapi
 * /api/v1/health:
 *   get:
 *     summary: Health check
 *     tags: [System]
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
app.get('/api/v1/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

/**
 * @openapi
 * /api/v1/analyze:
 *   post:
 *     summary: Analyze plant image (backwards compatible)
 *     description: Accepts raw JPEG. Uses built-in lettuce ONNX model.
 *     tags: [Inference]
 *     requestBody:
 *       required: true
 *       content:
 *         image/jpeg:
 *           schema:
 *             type: string
 *             format: binary
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AnalyzeV1Response'
 */
app.post('/api/v1/analyze', async (req: Request, res: Response) => {
  if (!req.body || !(req.body instanceof Buffer)) {
    res.status(400).json({ success: false, error: 'Expected raw image/jpeg body' });
    return;
  }

  try {
    const detections = await defaultAdapter.analyze(req.body);
    const aggregated = aggregateDetections(detections);

    // Legacy closed-loop decision (thresholds from lettuce-v1 training)
    const damageCount   = aggregated.find(d => d.className === 'Rusak')?.count ?? 0;
    const immatureCount = aggregated.find(d => d.className === 'Belum Matang')?.count ?? 0;

    let farm_control_action = 'maintain_current_state';
    if (damageCount > 2) farm_control_action = 'flush_nutrients_and_increase_watering';
    else if (immatureCount > 10) farm_control_action = 'extend_light_cycle_brightness';

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      detections_found: detections.length,
      detections: detections.slice(0, 5),
      aggregated,
      farm_control_action,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[v1/analyze] Inference error:', err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * @openapi
 * /api/v2/analyze:
 *   post:
 *     summary: Generic vision analysis
 *     description: |
 *       Selects adapter by `type`. Image must be base64-encoded.
 *       - `onnx_local`: uses built-in ONNX model (config.model = "lettuce" or future models)
 *       - `http`: proxies to config.url as image/jpeg POST
 *     tags: [Inference]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AnalyzeV2Request'
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AnalyzeV2Response'
 */
app.post('/api/v2/analyze', async (req: Request, res: Response) => {
  const { type, config: adapterConfig, image } = req.body as {
    type?: string;
    config?: Record<string, unknown>;
    image?: string;
  };

  if (!type || !image) {
    res.status(400).json({ error: 'Required fields: type, image (base64)' });
    return;
  }

  let adapter: IVisionAdapter;

  try {
    if (type === 'onnx_local') {
      adapter = defaultAdapter;
    } else if (type === 'http') {
      const url = adapterConfig?.['url'];
      if (typeof url !== 'string') {
        res.status(400).json({ error: 'config.url is required for type=http' });
        return;
      }
      adapter = new HttpAdapter({
        url,
        headers: adapterConfig?.['headers'] as Record<string, string> | undefined,
      });
    } else {
      res.status(400).json({ error: `Unknown adapter type: ${type}` });
      return;
    }

    const imageBuffer = Buffer.from(image, 'base64');
    const detections  = await adapter.analyze(imageBuffer);
    const aggregated  = aggregateDetections(detections);

    res.json({
      timestamp: new Date().toISOString(),
      detections: aggregated,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[v2/analyze] Error:', err);
    res.status(500).json({ error: message });
  }
});

async function start() {
  await defaultAdapter.init();
  app.listen(port, () => {
    console.log(`VLM Server  →  http://localhost:${port}`);
    console.log(`API docs    →  http://localhost:${port}/api/docs`);
  });
}

start();
