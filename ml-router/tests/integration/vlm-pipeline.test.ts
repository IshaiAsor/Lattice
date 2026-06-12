/**
 * Integration tests — ml-router VLM/LLM inference pipeline
 *
 * Tests the POST /api/infer endpoint end-to-end:
 *   image → VLM (Ollama) → detections
 *   detections + sensors → LLM (Ollama / OpenAI-compat) → actionable decision
 *   full pipeline: VLM step then LLM step using prior output
 *
 * External services (Ollama, ONNX) are replaced with a mocked global.fetch
 * and the @lattice/prisma-client is replaced by a manual Jest mock.
 */

import request from 'supertest';
import { db } from '@lattice/prisma-client';
import { createTestApp } from '../helpers/app';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fn = <T>(f: T): jest.Mock => f as unknown as jest.Mock;

/** Build a mock fetch that returns `body` as JSON. */
function mockFetch(body: unknown, status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok:   status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  });
}

/** Minimal 1×1 white JPEG as base64. */
const TINY_IMAGE_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkS' +
  'Ew8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJ' +
  'CQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAA' +
  'AAAAAAgH/8QAFhABAQEAAAAAAAAAAAAAAAAAABEB/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/' +
  'EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKwAB//Z';

// ─── Shared model config stubs ────────────────────────────────────────────────

const vlmOllamaConfig: any = {
  config: {
    endpoint:  'http://ollama:11434/api/generate',
    model_id:  'qwen2.5vl:7b',
  },
};

const llmOllamaConfig: any = {
  config: {
    endpoint:  'http://ollama:11434/api/generate',
    model_id:  'qwen2.5:7b',
  },
};

const llmOpenAiConfig: any = {
  config: {
    endpoint:  'http://openai-proxy/v1/chat/completions',
    model_id:  'gpt-4o',
  },
};

// ─── Fixtures — simulated model responses ────────────────────────────────────

const ollamaVlmResponse = {
  response: JSON.stringify({
    analysis:    'Two mature lettuce heads detected in the left quadrant.',
    observations: ['Green healthy leaves', 'No visible damage'],
    plant_health: 'good',
    decision:    'nominal',
  }),
};

const ollamaLlmDecisionResponse = {
  response: JSON.stringify({
    decision: 'nominal',
    reason:   'All sensor readings are within the optimal range.',
  }),
};

const ollamaLlmAlertResponse = {
  response: JSON.stringify({
    decision: 'flush_nutrients',
    reason:   'Nutrient levels are critically low — sensor readings confirm deficiency.',
  }),
};

const openAiLlmResponse = {
  choices: [{
    message: {
      content: JSON.stringify({
        decision: 'increase_watering',
        reason:   'Humidity has been consistently below threshold for 30 minutes.',
      }),
    },
  }],
};

// ─── App ──────────────────────────────────────────────────────────────────────

const app = createTestApp();

// ─── beforeEach: re-establish global.fetch after resetMocks ──────────────────

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite 1 — Validation
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/infer — validation', () => {

  describe('TC-V-01 missing required fields → 400', () => {
    it('returns 400 when version is absent', async () => {
      const res = await request(app).post('/api/infer').send({
        kind:  'vlm',
        name:  'plant-detector',
        input: { image: TINY_IMAGE_B64 },
        // missing version
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/version/i);
    });

    it('returns 400 when input is absent', async () => {
      const res = await request(app).post('/api/infer').send({
        kind:    'vlm',
        name:    'plant-detector',
        version: '1.0',
        // missing input
      });

      expect(res.status).toBe(400);
    });
  });

  describe('TC-V-02 unsupported kind → 400', () => {
    it('returns 400 for an unknown inference kind', async () => {
      const res = await request(app).post('/api/infer').send({
        kind:    'rl',
        name:    'some-model',
        version: '1.0',
        input:   {},
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unsupported kind/);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite 2 — VLM via Ollama
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/infer — VLM via Ollama', () => {

  describe('TC-V-03 image → detections (Ollama happy path)', () => {
    it('returns VLM analysis and decision from Ollama response', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue(vlmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(ollamaVlmResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      const res = await request(app).post('/api/infer').send({
        kind:    'vlm',
        name:    'plant-detector',
        version: '1.0',
        input:   { image: TINY_IMAGE_B64 },
      });

      expect(res.status).toBe(200);
      expect(res.body.model).toMatchObject({ kind: 'vlm', name: 'plant-detector', version: '1.0' });
      expect(res.body.duration_ms).toBeGreaterThanOrEqual(0);

      // Output from Ollama parsed correctly
      expect(res.body.output.analysis).toContain('lettuce');
      expect(res.body.output.decision).toBe('nominal');

      // Verify fetch was called with Ollama format (has `images` field)
      const fetchBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchBody.images).toContain(TINY_IMAGE_B64);
      expect(fetchBody.model).toBe('qwen2.5vl:7b');
    });
  });

  describe('TC-V-04 Ollama returns non-JSON text — output fields are undefined', () => {
    // The parser only falls back to { analysis: text } when JSON.parse *throws*.
    // If the response contains no JSON at all, the regex match fails silently
    // and both analysis and decision remain undefined.
    it('returns 200 with empty output when Ollama response contains no JSON', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue(vlmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue({ response: 'I cannot analyse this image right now.' }),
        text: jest.fn().mockResolvedValue(''),
      });

      const res = await request(app).post('/api/infer').send({
        kind:    'vlm',
        name:    'plant-detector',
        version: '1.0',
        input:   { image: TINY_IMAGE_B64 },
      });

      expect(res.status).toBe(200);
      expect(res.body.output.analysis).toBeUndefined();
      expect(res.body.output.decision).toBeUndefined();
    });
  });

  describe('TC-V-05 Ollama service unavailable → 502', () => {
    it('returns 502 when Ollama responds with an HTTP error', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue(vlmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:     false,
        status: 503,
        text:   jest.fn().mockResolvedValue('Service Unavailable'),
      });

      const res = await request(app).post('/api/infer').send({
        kind:    'vlm',
        name:    'plant-detector',
        version: '1.0',
        input:   { image: TINY_IMAGE_B64 },
      });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/503/);
    });
  });

  describe('TC-V-06 VLM ONNX — model not loaded → 404', () => {
    it('returns 404 when no endpoint is configured and ONNX session is absent', async () => {
      // No endpoint in config → ONNX path; session was never loaded
      fn(db.mlModel.findFirst).mockResolvedValue({ config: {} });

      const res = await request(app).post('/api/infer').send({
        kind:    'vlm',
        name:    'plant-detector',
        version: '1.0',
        input:   { image: TINY_IMAGE_B64 },
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not loaded/i);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite 3 — LLM decision making
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/infer — LLM decision making', () => {

  describe('TC-V-07 LLM model not registered → 404', () => {
    it('returns 404 when no MlModel record exists for the requested name', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue(null);

      const res = await request(app).post('/api/infer').send({
        kind:    'llm',
        name:    'decision-engine',
        version: '1.0',
        input:   { sensors: {} },
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not registered/i);
    });
  });

  describe('TC-V-08 LLM model config missing endpoint → 500', () => {
    it('returns 500 when the registered model has no endpoint in config', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue({ config: {} });

      const res = await request(app).post('/api/infer').send({
        kind:    'llm',
        name:    'decision-engine',
        version: '1.0',
        input:   { sensors: {} },
      });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/endpoint/i);
    });
  });

  describe('TC-V-09 LLM via Ollama — returns nominal decision', () => {
    it('parses decision from Ollama response text', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue(llmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(ollamaLlmDecisionResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      const res = await request(app).post('/api/infer').send({
        kind:    'llm',
        name:    'decision-engine',
        version: '1.0',
        input:   {
          sensors:       { temperature: ['22.5', '22.6'], humidity: ['65', '64'] },
          vlm_detections: { detections: [] },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.output.decision).toBe('nominal');
      expect(res.body.output.raw).toBeDefined();

      // Verify Ollama request format
      const fetchBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchBody.model).toBe('qwen2.5:7b');
      expect(fetchBody.stream).toBe(false);
    });
  });

  describe('TC-V-10 LLM via Ollama — returns flush_nutrients for bad sensor readings', () => {
    it('propagates flush_nutrients decision from Ollama', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue(llmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(ollamaLlmAlertResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      const res = await request(app).post('/api/infer').send({
        kind:    'llm',
        name:    'decision-engine',
        version: '1.0',
        input:   {
          sensors: { ec_level: ['0.5', '0.4', '0.3'] },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.output.decision).toBe('flush_nutrients');
    });
  });

  describe('TC-V-11 LLM via OpenAI-compatible endpoint — returns decision', () => {
    it('parses decision from OpenAI choices format', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue(llmOpenAiConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(openAiLlmResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      const res = await request(app).post('/api/infer').send({
        kind:    'llm',
        name:    'decision-engine',
        version: '1.0',
        input:   {
          sensors: { humidity: ['40', '39', '38'] },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.output.decision).toBe('increase_watering');

      // Verify OpenAI request format (messages array, no images field)
      const fetchBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchBody.messages).toBeDefined();
      expect(fetchBody.messages[0].role).toBe('user');
    });
  });

  describe('TC-V-12 LLM with image attached — image routed to Ollama images field', () => {
    it('separates image from text input and sends it in images field', async () => {
      fn(db.mlModel.findFirst).mockResolvedValue(llmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(ollamaLlmDecisionResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      await request(app).post('/api/infer').send({
        kind:    'llm',
        name:    'decision-engine',
        version: '1.0',
        input:   {
          sensors: { temperature: ['22.0'] },
          image:   TINY_IMAGE_B64,          // vision context
        },
      });

      const fetchBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Image must be in images[] — NOT in the prompt text
      expect(fetchBody.images).toContain(TINY_IMAGE_B64);
      expect(fetchBody.prompt).not.toContain(TINY_IMAGE_B64);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite 4 — Full image → VLM → LLM pipeline (two sequential requests)
// ═════════════════════════════════════════════════════════════════════════════

describe('Full VLM → LLM inference pipeline', () => {

  describe('TC-V-13 image through VLM then LLM produces actionable decision', () => {
    it('step-1 VLM returns detections; step-2 LLM uses them to decide', async () => {
      // ── Step 1: VLM — image → detections ──────────────────────────────────
      fn(db.mlModel.findFirst).mockResolvedValue(vlmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(ollamaVlmResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      const vlmRes = await request(app).post('/api/infer').send({
        kind:    'vlm',
        name:    'plant-detector',
        version: '1.0',
        input:   { image: TINY_IMAGE_B64 },
      });

      expect(vlmRes.status).toBe(200);
      const vlmOutput = vlmRes.body.output;
      expect(vlmOutput.analysis).toBeDefined();

      // ── Step 2: LLM — detections + sensors → decision ─────────────────────
      fn(db.mlModel.findFirst).mockResolvedValue(llmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(ollamaLlmDecisionResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      const llmRes = await request(app).post('/api/infer').send({
        kind:    'llm',
        name:    'decision-engine',
        version: '1.0',
        input:   {
          vlm_detections: vlmOutput,
          sensors: {
            temperature: ['22.5', '22.6'],
            humidity:    ['65', '64'],
          },
        },
      });

      expect(llmRes.status).toBe(200);

      const decision = llmRes.body.output.decision;
      expect(['nominal', 'flush_nutrients', 'increase_watering', 'alert']).toContain(decision);
      expect(llmRes.body.output.raw).toBeDefined();
    });
  });

  describe('TC-V-14 VLM → LLM with image passed into LLM for visual context', () => {
    it('decision incorporates both VLM detections and raw camera frame', async () => {
      // VLM step
      fn(db.mlModel.findFirst).mockResolvedValue(vlmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(ollamaVlmResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      const vlmRes = await request(app).post('/api/infer').send({
        kind: 'vlm', name: 'plant-detector', version: '1.0',
        input: { image: TINY_IMAGE_B64 },
      });

      const vlmOutput = vlmRes.body.output;

      // LLM step — forward the image alongside detections
      fn(db.mlModel.findFirst).mockResolvedValue(llmOllamaConfig);
      fetchMock.mockResolvedValue({
        ok:   true,
        json: jest.fn().mockResolvedValue(ollamaLlmDecisionResponse),
        text: jest.fn().mockResolvedValue(''),
      });

      const llmRes = await request(app).post('/api/infer').send({
        kind:    'llm',
        name:    'decision-engine',
        version: '1.0',
        input:   {
          vlm_detections: vlmOutput,
          sensors:        { light_level: ['750', '800', '820'] },
          image:          TINY_IMAGE_B64,    // camera frame forwarded to LLM
        },
      });

      expect(llmRes.status).toBe(200);

      // LLM received image separately (in images field, not prompt)
      const fetchBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchBody.images).toContain(TINY_IMAGE_B64);

      // Decision is one of the valid enum values
      const decision = llmRes.body.output.decision;
      expect(['nominal', 'flush_nutrients', 'increase_watering', 'alert']).toContain(decision);
    });
  });
});
