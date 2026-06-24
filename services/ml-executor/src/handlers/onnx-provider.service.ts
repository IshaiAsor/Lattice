import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { resolve } from 'path';
import { createLogger } from '@lattice/logger';
import type { ChatMessage, Detection, BoundingBox } from '@lattice/ml';
import { env } from '../config/env.config';
import type { ModelConfig } from '../models';
import type { IVlmProvider } from './IVlmProvider';

const log = createLogger('ml-executor:vlm');

// Lazy-loaded ONNX sessions keyed by resolved model path.
const _sessions = new Map<string, ort.InferenceSession>();

async function getSession(model: ModelConfig): Promise<ort.InferenceSession> {
  // Layout: {onnxModelsDir}/{name}/{version}/{modelFile}
  const path = resolve(env.onnxModelsDir, model.name, model.version, model.modelFile!);
  if (!_sessions.has(path)) {
    _sessions.set(path, await ort.InferenceSession.create(path));
  }
  return _sessions.get(path)!;
}

const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD  = 0.45;

function iou(a: BoundingBox, b: BoundingBox): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.w, b.x + b.w);
  const iy2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(dets: Detection[]): Detection[] {
  dets.sort((a, b) => b.confidence - a.confidence);
  const suppressed = new Set<number>();
  const kept: Detection[] = [];
  for (let i = 0; i < dets.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(dets[i]);
    for (let j = i + 1; j < dets.length; j++) {
      const bi = dets[i].box;
      const bj = dets[j].box;
      if (dets[i].label === dets[j].label && bi && bj && iou(bi, bj) > IOU_THRESHOLD) {
        suppressed.add(j);
      }
    }
  }
  return kept;
}

async function runOnnx(model: ModelConfig, imageBase64: string): Promise<Detection[]> {
  const imageBuffer = Buffer.from(imageBase64, 'base64');

  // Resize to 640×640, drop alpha, keep RGB — output is HWC uint8
  const raw = await sharp(imageBuffer)
    .resize(640, 640, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();

  // Reorder HWC → CHW and normalise 0–255 to 0–1
  const numPixels = 640 * 640;
  const float32 = new Float32Array(3 * numPixels);
  for (let i = 0; i < numPixels; i++) {
    float32[i]                = raw[i * 3]!     / 255.0;  // R plane
    float32[numPixels + i]    = raw[i * 3 + 1]! / 255.0;  // G plane
    float32[2 * numPixels + i] = raw[i * 3 + 2]! / 255.0; // B plane
  }

  const session = await getSession(model);
  const tensor = new ort.Tensor('float32', float32, [1, 3, 640, 640]);
  const results = await session.run({ [session.inputNames[0]!]: tensor });
  const outTensor = results[session.outputNames[0]!];
  const outputData = outTensor?.data as Float32Array | undefined;
  if (!outputData) return [];
  const data: Float32Array = outputData;

  const nc = model.classes?.length ?? 0;
  const dims = outTensor!.dims;

  // Ultralytics YOLO11 ONNX exports in one of two layouts, with or without batch dim:
  //   [1, 4+nc, na] or [4+nc, na]  — columnar (default simplify export)
  //   [1, na, 4+nc] or [na, 4+nc]  — transposed (some export configs)
  // For 2D output the batch dim is squeezed; detect layout from the remaining dims.
  let columnar: boolean;
  let na: number;
  if (dims.length === 2) {
    columnar = dims[0] === 4 + nc;
    na = columnar ? dims[1]! : dims[0]!;
  } else {
    columnar = dims[1] === 4 + nc;
    na = columnar ? dims[2]! : dims[1]!;
  }

  // Diagnostic: log dims and sample raw values so layout issues are visible in service logs.
  // Sample the "class score" field for the first anchor in each possible layout so the
  // correct one (values in logit range ~-10..+10) is identifiable.
  const sampleColumnar   = data[4 * na + 0];
  const sampleTransposed = data[0 * (4 + nc) + 4];
  log.debug({ dims: Array.from(dims), nc, na, columnar, dataLen: data.length, sampleColumnar, sampleTransposed }, 'ONNX tensor layout');

  function getVal(anchor: number, field: number): number {
    return columnar
      ? data[field * na + anchor]!
      : data[anchor * (4 + nc) + field]!;
  }

  // Class scores are raw logits — apply sigmoid before thresholding.
  // If the model fuses sigmoid into the ONNX graph the scores will already be in [0,1]
  // and applying sigmoid again flattens everything toward 0.7; if you see that, remove
  // this call and use the raw score directly.
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

  const detections: Detection[] = [];
  for (let a = 0; a < na; a++) {
    let bestClass = 0;
    let bestScore = sigmoid(getVal(a, 4));
    for (let c = 1; c < nc; c++) {
      const score = sigmoid(getVal(a, 4 + c));
      if (score > bestScore) { bestScore = score; bestClass = c; }
    }
    // NaN arises from out-of-bounds reads (na slightly larger than actual anchor count).
    if (!isFinite(bestScore) || bestScore < CONF_THRESHOLD) continue;

    const cx = getVal(a, 0);
    const cy = getVal(a, 1);
    const w  = getVal(a, 2);
    const h  = getVal(a, 3);
    // Skip degenerate boxes — zero/negative w or h breaks IOU and produces garbage output.
    if (!isFinite(cx) || !isFinite(cy) || w <= 0 || h <= 0) continue;
    detections.push({
      label: model.classes?.[bestClass] ?? String(bestClass),
      confidence: bestScore,
      box: { x: cx - w / 2, y: cy - h / 2, w, h },
    });
  }

  return nms(detections);
}

export class OnnxVlmProvider implements IVlmProvider {
  constructor(private readonly model: ModelConfig) {}

  async detect(messages: ChatMessage[]): Promise<Detection[]> {
    const image = messages.find((m) => m.image)?.image;
    if (!image) throw new Error('No image in messages for VLM inference');
    return runOnnx(this.model, image);
  }
}
