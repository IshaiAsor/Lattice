export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  image?: string;
}

// Model selector — used by all three transports
export interface ModelId {
  kind: 'llm' | 'vlm';
  name: string;
  version: string;
}

// VLM output types
export interface BoundingBox { x: number; y: number; w: number; h: number; }
export interface Detection { label: string; confidence: number; box?: BoundingBox; }

// Unified inference response for HTTP and the single-shot path of the Redis transport.
export interface InferResponse {
  text?: string;
  detections?: Detection[];
  durationMs: number;
}

// The single generic Redis inference job. `stream: true` (LLM only) yields token chunks;
// otherwise the worker returns one result chunk. VLM = message with image set.
export interface InferJobPayload {
  requestId: string;
  model: ModelId;
  messages: ChatMessage[];
  stream: boolean;
}

// The generic streamed response protocol on infer:response:<requestId>. A request yields a
// sequence of chunks terminated by `done` (or `error` then `done`):
//   stream LLM → many `token` chunks
//   single-shot LLM / VLM → one `result` chunk
export type InferChunk =
  | { type: 'token'; text: string }
  | { type: 'result'; result: InferResponse }
  | { type: 'done' }
  | { type: 'error'; message: string };

// Edge → orchestrator. No model — the orchestrator maps chatMode to a plan and decides.
// chatMode is the client's vocabulary (e.g. 'free' | 'device-context' | 'build').
export interface ChatIntentPayload {
  requestId: string;
  userId: string;
  chatMode: string;
  messages: ChatMessage[];
  stream: boolean;
}