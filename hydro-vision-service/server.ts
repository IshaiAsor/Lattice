/**
 * Hydro Vision Service — Express entry point.
 *
 * Accepts raw JPEG images from ESP32-CAM modules and returns YOLOv8 lettuce
 * detections plus a closed-loop farm control instruction.
 *
 * Endpoints:
 *   GET  /api/v1/health   — liveness probe
 *   POST /api/v1/analyze  — plant image inference
 *   GET  /api/docs        — Swagger UI
 */

import express from 'express';
import type { Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { PlantVisionEngine } from './inference.ts';
import { components } from './swagger.ts';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

const engine = new PlantVisionEngine(path.join(__dirname, 'best.onnx'));

// express.raw is required because ESP32 cameras POST the JPEG bytes directly
// as the request body rather than using multipart/form-data.
app.use(express.json());
app.use(express.raw({ type: 'image/jpeg', limit: '10mb' }));

const swaggerSpec = swaggerJsdoc({
    definition: {
        openapi: '3.0.3',
        info: {
            title: 'Hydro Vision Service',
            version: '1.0.0',
            description: `YOLOv8 plant health inference service for hydroponic farms.

**Detection classes:** Belum Matang (Immature) · Matang (Mature) · Rusak (Damaged)

**Farm actions:** \`maintain_current_state\` · \`flush_nutrients_and_increase_watering\` · \`extend_light_cycle_brightness\``,
        },
        components,
    },
    apis: [fileURLToPath(import.meta.url)],
});

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @openapi
 * /api/v1/health:
 *   get:
 *     summary: Service health check
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
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

/**
 * @openapi
 * /api/v1/analyze:
 *   post:
 *     summary: Analyze plant image
 *     description: Send a raw JPEG binary (Content-Type image/jpeg). Returns top-5 detections and a farm action.
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
 *               $ref: '#/components/schemas/AnalyzeResponse'
 *       400:
 *         description: Missing or invalid image
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Inference failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post('/api/v1/analyze', async (req: Request, res: Response) => {
    try {
        if (!req.body || !(req.body instanceof Buffer)) {
            return res.status(400).json({ error: "Invalid or missing image binary payload" });
        }

        const detections = await engine.analyzeImage(req.body);

        // Closed-loop decision engine: map detection counts to farm actions.
        // Thresholds determined empirically from the lettuce-v1 training set:
        //   >2 damaged  → systemic nutrient/pH issue → flush
        //   >10 immature → insufficient photosynthesis → more light
        let controlInstruction = "maintain_current_state";
        const damageCount = detections.filter(d => d.className === 'Rusak').length;
        const immatureCount = detections.filter(d => d.className === 'Belum Matang').length;

        if (damageCount > 2) {
            controlInstruction = "flush_nutrients_and_increase_watering";
        } else if (immatureCount > 10) {
            controlInstruction = "extend_light_cycle_brightness";
        }

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            detections_found: detections.length,
            detections: detections.slice(0, 5), // top-5 by confidence
            farm_control_action: controlInstruction
        });

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Inference pipeline failure:", error);
        res.status(500).json({ success: false, error: message });
    }
});

async function start() {
    await engine.init();
    app.listen(port, () => {
        console.log(`Hydro Vision Service  →  http://localhost:${port}`);
        console.log(`API docs              →  http://localhost:${port}/api/docs`);
    });
}

start();
