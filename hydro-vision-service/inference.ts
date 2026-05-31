/**
 * PlantVisionEngine — ONNX inference pipeline for lettuce health detection.
 *
 * Wraps an ONNX Runtime session and handles the full image-to-detections
 * pipeline: JPEG decode → resize → CHW normalization → inference → NMS.
 *
 * The model is a YOLOv8-nano network exported to ONNX format, trained on
 * the lettuce-v1 dataset (5,170 images, Roboflow, CC BY 4.0).
 */

import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const CLASSES = ['Belum Matang', 'Matang', 'Rusak'];

export interface Detection {
    classId: number;
    className: string;
    confidence: number;
    box: { x1: number; y1: number; x2: number; y2: number };
}

export class PlantVisionEngine {
    private session: ort.InferenceSession | null = null;
    private modelPath: string;

    constructor(modelPath: string) {
        this.modelPath = modelPath;
    }

    /** Load the ONNX model into memory. Must be called once before analyzeImage(). */
    async init() {
        this.session = await ort.InferenceSession.create(this.modelPath);
        console.log('ONNX Model loaded successfully.');
    }

    /**
     * Full inference pipeline for a single JPEG image buffer.
     *
     * Stages:
     *   1. Decode + resize to 640×640 (the input resolution the model was trained on)
     *   2. Convert interleaved HWC uint8 pixels to planar CHW float32 in [0, 1]
     *   3. Run ONNX forward pass
     *   4. Parse output tensor → filter by confidence → NMS → sort by confidence desc
     */
    async analyzeImage(imageBuffer: Buffer): Promise<Detection[]> {
        if (!this.session) throw new Error("Model session not initialized");

        // Stage 1 — resize to the model's expected input resolution.
        // 'fill' stretches the image rather than padding; this matches how the
        // dataset was pre-processed during training (Roboflow stretch resize).
        const { data } = await sharp(imageBuffer)
            .resize(640, 640, { fit: 'fill' })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const pixelCount = 640 * 640;

        // Stage 2 — convert HWC uint8 (R,G,B,R,G,B,...) to CHW float32.
        // ONNX expects channel-first layout: all R values, then all G, then all B.
        // Divide by 255 to normalise pixel values to [0, 1].
        const float32Data = new Float32Array(3 * pixelCount);

        for (let i = 0; i < pixelCount; i++) {
            const r = data[i * 3] ?? 0;
            const g = data[i * 3 + 1] ?? 0;
            const b = data[i * 3 + 2] ?? 0;

            float32Data[i] = r / 255.0;
            float32Data[i + pixelCount] = g / 255.0;
            float32Data[i + 2 * pixelCount] = b / 255.0;
        }

        const inputName = this.session.inputNames[0];
        if (!inputName) throw new Error('ONNX model has no input name');

        // Shape: [batch=1, channels=3, height=640, width=640]
        const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, 640, 640]);

        // Stage 3 — forward pass
        const outputs = await this.session.run({ [inputName]: inputTensor });
        const outputName = this.session.outputNames[0];
        if (!outputName) throw new Error('ONNX model has no output name');

        const outputTensor = outputs[outputName];
        if (!outputTensor) throw new Error('ONNX model returned no output tensor');

        // Stage 4 — parse raw tensor into Detection objects
        return this.parseOutput(outputTensor.data as Float32Array, outputTensor.dims);
    }

    /**
     * Numerically stable softmax over a small array of class logits.
     *
     * YOLOv8 exports raw class scores (logits), not probabilities. Softmax is
     * applied here before thresholding so confidence values are properly bounded
     * to [0, 1] and sum to 1 across classes.
     */
    private softmax(values: number[]): number[] {
        const max = Math.max(...values);
        const exps = values.map(v => Math.exp(v - max));
        const sum = exps.reduce((acc, value) => acc + value, 0) || 1;
        return exps.map(value => value / sum);
    }

    /**
     * Intersection-over-Union between two detections' bounding boxes.
     * Used by NMS to determine whether two boxes overlap significantly.
     */
    private intersectionOverUnion(a: Detection, b: Detection): number {
        const x1 = Math.max(a.box.x1, b.box.x1);
        const y1 = Math.max(a.box.y1, b.box.y1);
        const x2 = Math.min(a.box.x2, b.box.x2);
        const y2 = Math.min(a.box.y2, b.box.y2);

        const width = Math.max(0, x2 - x1);
        const height = Math.max(0, y2 - y1);
        const intersection = width * height;
        if (intersection === 0) return 0;

        const areaA = Math.max(0, a.box.x2 - a.box.x1) * Math.max(0, a.box.y2 - a.box.y1);
        const areaB = Math.max(0, b.box.x2 - b.box.x1) * Math.max(0, b.box.y2 - b.box.y1);
        const union = areaA + areaB - intersection;
        return union > 0 ? intersection / union : 0;
    }

    /**
     * Greedy Non-Maximum Suppression — removes duplicate boxes for the same object.
     *
     * Algorithm: sort by confidence desc, greedily pick the top box, then remove
     * any same-class boxes whose IoU with the picked box exceeds the threshold.
     * IoU threshold of 0.45 is the standard YOLOv8 default.
     */
    private nonMaxSuppression(detections: Detection[], iouThreshold = 0.45): Detection[] {
        const results: Detection[] = [];
        const sorted = detections.slice().sort((a, b) => b.confidence - a.confidence);

        while (sorted.length > 0) {
            const current = sorted.shift()!;
            results.push(current);

            for (let i = sorted.length - 1; i >= 0; i--) {
                const candidate = sorted[i];
                if (!candidate || current.classId !== candidate.classId) continue;
                if (this.intersectionOverUnion(current, candidate) > iouThreshold) {
                    sorted.splice(i, 1);
                }
            }
        }

        return results;
    }

    /**
     * Parse the raw ONNX output tensor into Detection objects.
     *
     * YOLOv8 ONNX output shape is [1, 7, N] (column-major) or [1, N, 7] (row-major)
     * where 7 = [cx, cy, w, h, score_class0, score_class1, score_class2].
     *
     * The column-major layout is the default ONNX export; row-major can appear
     * when the model is re-exported or quantised. We auto-detect by checking
     * whether dims[1] or dims[2] equals 7 (the element count per prediction).
     *
     * Coordinates are normalised [0, 1] in the output; we scale them to pixels
     * relative to the 640×640 input and convert centre-width to corner format.
     */
    private parseOutput(data: Float32Array, dims: readonly number[]): Detection[] {
        if (dims.length < 3) {
            throw new Error('Unexpected ONNX output dimensions');
        }

        const numElements = dims[1]!;
        const numPredictions = dims[2]!;
        let rowMajor = false;

        let actualNumElements = numElements;
        let actualNumPredictions = numPredictions;

        // Auto-detect row-major layout: if dim[1] is not 7 but dim[2] is, swap.
        if (actualNumElements !== 7 && dims[2] === 7) {
            actualNumElements = dims[2]!;
            actualNumPredictions = dims[1]!;
            rowMajor = true;
        }

        if (actualNumElements < 7) {
            throw new Error('Unexpected ONNX output element count');
        }

        const detections: Detection[] = [];
        const confidenceThreshold = 0.5;
        const classCount = Math.min(CLASSES.length, actualNumElements - 4);

        for (let p = 0; p < actualNumPredictions; p++) {
            const logits: number[] = [];
            for (let c = 0; c < classCount; c++) {
                const scoreIndex = rowMajor
                    ? p * actualNumElements + 4 + c
                    : (4 + c) * actualNumPredictions + p;
                logits.push(data[scoreIndex] ?? 0);
            }

            const probabilities = this.softmax(logits);
            const maxConfidence = Math.max(...probabilities);
            const classId = probabilities.indexOf(maxConfidence);

            if (maxConfidence > confidenceThreshold && classId >= 0) {
                // Convert normalised centre-width (cx,cy,w,h) to corner (x1,y1,x2,y2)
                // and scale from [0,1] to pixel space at 640×640.
                const cx = ((rowMajor ? data[p * actualNumElements + 0] : data[0 * actualNumPredictions + p]) ?? 0) as number;
                const cy = ((rowMajor ? data[p * actualNumElements + 1] : data[1 * actualNumPredictions + p]) ?? 0) as number;
                const w = ((rowMajor ? data[p * actualNumElements + 2] : data[2 * actualNumPredictions + p]) ?? 0) as number;
                const h = ((rowMajor ? data[p * actualNumElements + 3] : data[3 * actualNumPredictions + p]) ?? 0) as number;

                const x1 = cx * 640 - (w * 640) / 2;
                const y1 = cy * 640 - (h * 640) / 2;
                const x2 = cx * 640 + (w * 640) / 2;
                const y2 = cy * 640 + (h * 640) / 2;

                detections.push({
                    classId,
                    className: CLASSES[classId] ?? 'Unknown',
                    confidence: maxConfidence,
                    box: { x1, y1, x2, y2 }
                });
            }
        }

        return this.nonMaxSuppression(detections).sort((a, b) => b.confidence - a.confidence);
    }
}
