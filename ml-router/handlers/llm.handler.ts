/**
 * LLM handler — HTTP proxy to any OpenAI-compatible or Ollama endpoint.
 *
 * The endpoint URL and model identifier are stored in ml_models.config:
 *   { endpoint: "http://localhost:11434/api/generate", model_id: "qwen2.5vl:7b" }
 *
 * Input format (from pipeline-worker — sensor_digest output + optional image):
 *   { vlm_detections: {...}, sensors: {...}, image?: base64_string }
 *
 * If input.image is present, it is extracted and sent in the Ollama `images` field
 * (or as an image_url message for OpenAI-compatible endpoints), so vision-capable
 * models like qwen2.5vl see the raw frame alongside the structured data.
 *
 * Output: raw JSON from the model, plus a parsed `decision` field if present.
 */
import { createLogger } from '@lattice/logger';

const log = createLogger('ml-router:llm');

export type LlmModelConfig = {
  endpoint:  string;
  model_id?: string;
  // Optional override prompt template — uses {input} placeholder
  prompt_template?: string;
};

export type LlmInput  = Record<string, unknown>;
export type LlmOutput = { raw: unknown; decision?: string };

const DEFAULT_PROMPT_TEMPLATE =
  'You are an autonomous farm controller. ' +
  'You receive sensor readings (current and historical) and optionally visual detections from a YOLO ' +
  'plant health model. If an image is also provided, use it for additional context. ' +
  'Based on all available data, return a single JSON object with: ' +
  '"decision" (one of: nominal, flush_nutrients, increase_watering, alert), ' +
  '"reason" (one sentence explaining why). ' +
  'Input data: {input}. ' +
  'Respond with JSON only.';

export async function runLlm(
  name: string,
  version: string,
  modelConfig: LlmModelConfig,
  input: LlmInput,
): Promise<LlmOutput> {
  const { endpoint, model_id, prompt_template } = modelConfig;

  // Extract image if present — keep it out of the text prompt, send via images field instead
  const { image, ...textInput } = input as { image?: string } & Record<string, unknown>;

  const prompt = (prompt_template ?? DEFAULT_PROMPT_TEMPLATE)
    .replace('{input}', JSON.stringify(textInput));

  const isOllama = endpoint.includes('/api/generate');

  // Build request body — Ollama uses `images: [base64]`, OpenAI uses image_url content blocks
  const body = isOllama
    ? {
        model:  model_id ?? name,
        prompt,
        stream: false,
        ...(image ? { images: [image] } : {}),
      }
    : {
        model:    model_id ?? name,
        messages: [
          {
            role: 'user',
            content: image
              ? [
                  { type: 'text',      text: prompt },
                  { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
                ]
              : prompt,
          },
        ],
      };

  log.debug({ name, version, endpoint }, 'sending LLM request');

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`LLM endpoint ${endpoint} returned ${res.status}: ${await res.text()}`),
      { status: 502 },
    );
  }

  const raw = await res.json() as Record<string, unknown>;

  // Extract the text response (handle Ollama vs OpenAI format)
  const text: string = (isOllama
    ? raw.response
    : ((raw.choices as any)?.[0]?.message?.content)) as string ?? '';

  // Try to parse a JSON decision from the response text
  let decision: string | undefined;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      decision = typeof parsed.decision === 'string' ? parsed.decision : undefined;
    }
  } catch {
    // Response wasn't JSON — decision remains undefined
  }

  return { raw, decision };
}
