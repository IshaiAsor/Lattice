/**
 * VLM handler — wraps PlantVisionEngine (adapted from vlm-server/inference.ts)
 * for generic routing by (name, version).
 *
 * ONNX sessions are cached in memory; models are loaded on first inference request
 * (lazy) or pre-warmed at startup via warmAll().
 */
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import config from '../config/env.config';
import { createLogger } from '@lattice/logger';

const log = createLogger('ml-router:vlm');

// ─── Detection types ──────────────────────────────────────────────────────────

export interface Detection {
  classId:    number;
  className:  string;
  confidence: number;
  box: { x1: number; y1: number; x2: number; y2: number };
}

// ─── Session cache ────────────────────────────────────────────────────────────

const sessions = new Map<string, { session: ort.InferenceSession; classes: string[] }>();

function sessionKey(name: string, version: string) { return `${name}:${version}`; }

function modelPath(name: string, version: string): string {
  return path.join(config.onnxModelsDir, name, `${version}.onnx`);
}

export function loadedModelKeys(): string[] {
  return [...sessions.keys()];
}

export async function loadModel(name: string, version: string, classes: string[]): Promise<void> {
  const key = sessionKey(name, version);
  if (sessions.has(key)) return;

  const filePath = modelPath(name, version);
  if (!fs.existsSync(filePath)) {
    throw new Error(`ONNX model file not found: ${filePath}`);
  }

  log.info({ name, version, filePath }, 'loading ONNX model');
  const session = await ort.InferenceSession.create(filePath);
  sessions.set(key, { session, classes });
  log.info({ name, version }, 'ONNX model loaded');
}

// ─── Image processing (adapted from PlantVisionEngine) ───────────────────────

async function preprocessImage(imageBuffer: Buffer): Promise<Float32Array> {
  const { data } = await sharp(imageBuffer)
    .resize(640, 640, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = 640 * 640;
  const float32 = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    float32[i]                   = (data[i * 3]     ?? 0) / 255;
    float32[i + pixelCount]      = (data[i * 3 + 1] ?? 0) / 255;
    float32[i + 2 * pixelCount]  = (data[i * 3 + 2] ?? 0) / 255;
  }
  return float32;
}

function softmax(values: number[]): number[] {
  const max  = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum  = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.box.x1, b.box.x1);
  const y1 = Math.max(a.box.y1, b.box.y1);
  const x2 = Math.min(a.box.x2, b.box.x2);
  const y2 = Math.min(a.box.y2, b.box.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (!inter) return 0;
  const areaA = (a.box.x2 - a.box.x1) * (a.box.y2 - a.box.y1);
  const areaB = (b.box.x2 - b.box.x1) * (b.box.y2 - b.box.y1);
  return inter / (areaA + areaB - inter);
}

function nms(detections: Detection[], iouThreshold = 0.45): Detection[] {
  const sorted = detections.slice().sort((a, b) => b.confidence - a.confidence);
  const results: Detection[] = [];
  while (sorted.length) {
    const current = sorted.shift()!;
    results.push(current);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = sorted[i];
      if (candidate && current.classId === candidate.classId && iou(current, candidate) > iouThreshold) {
        sorted.splice(i, 1);
      }
    }
  }
  return results;
}

function parseYoloOutput(data: Float32Array, dims: readonly number[], classes: string[]): Detection[] {
  if (dims.length < 3) throw new Error('Unexpected ONNX output dimensions');

  let numElements    = dims[1]!;
  let numPredictions = dims[2]!;
  let rowMajor = false;

  if (numElements !== 7 && dims[2] === 7) {
    [numElements, numPredictions] = [dims[2]!, dims[1]!];
    rowMajor = true;
  }

  const classCount = Math.min(classes.length, numElements - 4);
  const detections: Detection[] = [];

  for (let p = 0; p < numPredictions; p++) {
    const logits = Array.from({ length: classCount }, (_, c) => {
      const idx = rowMajor ? p * numElements + 4 + c : (4 + c) * numPredictions + p;
      return data[idx] ?? 0;
    });

    const probs       = softmax(logits);
    const maxConf     = Math.max(...probs);
    const classId     = probs.indexOf(maxConf);

    if (maxConf < 0.5 || classId < 0) continue;

    const get = (offset: number) => (rowMajor ? data[p * numElements + offset] : data[offset * numPredictions + p]) ?? 0;
    const [cx, cy, w, h] = [get(0), get(1), get(2), get(3)];

    detections.push({
      classId,
      className:  classes[classId] ?? 'Unknown',
      confidence: maxConf,
      box: {
        x1: cx * 640 - (w * 640) / 2,
        y1: cy * 640 - (h * 640) / 2,
        x2: cx * 640 + (w * 640) / 2,
        y2: cy * 640 + (h * 640) / 2,
      },
    });
  }

  return nms(detections).sort((a, b) => b.confidence - a.confidence);
}

// ─── ONNX inference (YOLOv8-style) ───────────────────────────────────────────

export type VlmInput  = { image: string };
export type VlmOutput = { detections?: Detection[]; analysis?: string; decision?: string; raw?: unknown };

export async function runVlmOnnx(name: string, version: string, input: VlmInput): Promise<VlmOutput> {
  const key = sessionKey(name, version);
  const entry = sessions.get(key);
  if (!entry) throw Object.assign(new Error(`VLM ONNX model not loaded: ${key}`), { status: 404 });

  const { session, classes } = entry;

  const imageBuffer = Buffer.from(input.image, 'base64');
  const float32     = await preprocessImage(imageBuffer);
  const inputName   = session.inputNames[0];
  if (!inputName) throw new Error('ONNX model has no input name');

  const tensor  = new ort.Tensor('float32', float32, [1, 3, 640, 640]);
  const outputs = await session.run({ [inputName]: tensor });
  const outName = session.outputNames[0];
  if (!outName) throw new Error('ONNX model has no output name');

  const outTensor = outputs[outName];
  if (!outTensor) throw new Error('ONNX model returned no output');

  const detections = parseYoloOutput(outTensor.data as Float32Array, outTensor.dims, classes);
  return { detections };
}

// ─── Ollama vision inference (qwen2.5vl and similar) ─────────────────────────

export type VlmOllamaConfig = {
  endpoint:         string;    // e.g. http://localhost:11434/api/generate
  model_id?:        string;    // Ollama model tag, defaults to `${name}:${version}`
  prompt_template?: string;
};

const DEFAULT_VLM_PROMPT =
  'Analyse this image. Return a JSON object with: ' +
  '"analysis" (brief description of what you observe), ' +
  '"observations" (array of specific visual findings), ' +
  '"plant_health" (overall visual health: good/poor/critical). ' +
  'Respond with JSON only — no markdown, no explanation.';

export async function runVlmOllama(
  name: string,
  version: string,
  cfg: VlmOllamaConfig,
  input: VlmInput,
): Promise<VlmOutput> {
  const modelId = cfg.model_id ?? `${name}:${version}`;
  const prompt  = cfg.prompt_template ?? DEFAULT_VLM_PROMPT;
  const isOllama = cfg.endpoint.includes('/api/');

  const body = isOllama
    ? { model: modelId, prompt, images: [input.image], stream: false }
    : {
        model:    modelId,
        messages: [{ role: 'user', content: [
          { type: 'text',  text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image}` } },
        ]}],
      };

  log.debug({ name, version, endpoint: cfg.endpoint, modelId }, 'VLM Ollama request');

  const res = await fetch(cfg.endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`Ollama VLM ${cfg.endpoint} returned ${res.status}: ${await res.text()}`),
      { status: 502 },
    );
  }

  const raw = await res.json() as Record<string, unknown>;
  const text = (isOllama ? raw.response : ((raw.choices as any)?.[0]?.message?.content)) as string ?? '';

  let parsed: Record<string, unknown> = {};
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    parsed = { analysis: text };
  }

  return {
    analysis:  parsed.analysis  as string | undefined,
    decision:  parsed.decision  as string | undefined,
    raw:       parsed,
  };
}

// ─── Unified public API — router decides ONNX vs Ollama ──────────────────────

// Kept for backward compat; infer.routes.ts now routes directly to runVlmOnnx/runVlmOllama
export async function runVlm(name: string, version: string, input: VlmInput): Promise<VlmOutput> {
  return runVlmOnnx(name, version, input);
}
