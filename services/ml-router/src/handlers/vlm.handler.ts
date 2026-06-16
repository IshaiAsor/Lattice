import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { resolve } from 'path';
import { env } from '../config/env.config';
import type { ModelConfig } from '../models';

export interface BoundingBox { x: number; y: number; w: number; h: number }
export interface Detection { label: string; confidence: number; box?: BoundingBox }
export interface VlmOutput { detections: Detection[] }

// Lazy-loaded ONNX sessions keyed by absolute model path.
const _sessions = new Map<string, ort.InferenceSession>();

async function getSession(modelFile: string): Promise<ort.InferenceSession> {
  const path = resolve(env.onnxModelsDir, modelFile);
  if (!_sessions.has(path)) {
    _sessions.set(path, await ort.InferenceSession.create(path));
  }
  return _sessions.get(path)!;
}

async function runOnnx(model: ModelConfig, imageBase64: string): Promise<VlmOutput> {
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const { data, info } = await sharp(imageBuffer)
    .resize(640, 640, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const float32 = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) float32[i] = data[i]! / 255.0;

  const tensor = new ort.Tensor('float32', float32, [1, info.channels, 640, 640]);
  const session = await getSession(model.modelFile!);
  const results = await session.run({ [session.inputNames[0]!]: tensor });
  const output = results[session.outputNames[0]!];

  // Parse YOLO-style output [batch, num_detections, 6]: cx,cy,w,h,conf,class_id
  const detections: Detection[] = [];
  if (output) {
    const raw = output.data as Float32Array;
    const stride = 6;
    for (let i = 0; i < raw.length; i += stride) {
      const conf = raw[i + 4]!;
      if (conf < 0.25) continue;
      const classId = Math.round(raw[i + 5]!);
      const label = model.classes?.[classId] ?? String(classId);
      detections.push({
        label,
        confidence: conf,
        box: { x: raw[i]!, y: raw[i + 1]!, w: raw[i + 2]!, h: raw[i + 3]! },
      });
    }
  }
  return { detections };
}

async function runOllama(model: ModelConfig, imageBase64: string): Promise<VlmOutput> {
  const res = await fetch(`${env.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.ollamaModel,
      prompt: 'Describe what you detect in this image. List each object with its confidence as a JSON array of {label, confidence} objects. Respond with JSON only.',
      images: [imageBase64],
      format: 'json',
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama VLM error: ${res.status}`);
  const body = await res.json() as { response: string };
  const parsed = JSON.parse(body.response) as Detection[] | { detections: Detection[] };
  const detections = Array.isArray(parsed) ? parsed : parsed.detections ?? [];
  return { detections };
}

export async function runVlm(model: ModelConfig, input: { image: string }): Promise<VlmOutput> {
  return model.backend === 'onnx'
    ? runOnnx(model, input.image)
    : runOllama(model, input.image);
}
