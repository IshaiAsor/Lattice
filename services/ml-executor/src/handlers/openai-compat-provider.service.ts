import { Agent, fetch as undiciFetch } from 'undici';
import { createLogger } from '@lattice/logger';
import type { ChatMessage, InferResponse } from '@lattice/ml';
import { env } from '../config/env.config';
import type { GenerateOptions, ILlmProvider } from './ILlmProvider';

const log = createLogger('ml-executor:llm-openai');

// Shared dispatcher so remote calls get the same generous timeout as the Ollama path — a busy
// free-tier endpoint can be slow to first byte, and we'd rather wait than fail a live request.
const remoteAgent = new Agent({ headersTimeout: env.llmTimeoutMs, bodyTimeout: env.llmTimeoutMs });

export interface OpenAICompatConfig {
  baseUrl: string; // e.g. https://api.groq.com/openai/v1
  apiKey: string;
  model: string; // remote model id
  label: string; // registry name, for logs only
}

interface ChatCompletionChoice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
}
interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

// A single provider for every OpenAI-compatible LLM endpoint (Groq, Gemini's OpenAI shim,
// Cerebras, OpenRouter, …). Only the base URL, key and model id differ — those come from the
// model registry, so a new provider is a config entry, not new code.
export class OpenAICompatProviderService implements ILlmProvider {
  constructor(private readonly cfg: OpenAICompatConfig) {}

  // ChatMessage → OpenAI `messages`. A message with an image becomes the multimodal content
  // array; text-only stays a plain string (the widest-compatible shape for free text models).
  private toOpenAiMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => {
      if (!m.image) return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${m.image}` } },
        ],
      };
    });
  }

  private async post(body: Record<string, unknown>): Promise<ReturnType<typeof undiciFetch>> {
    const res = await undiciFetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      dispatcher: remoteAgent,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${this.cfg.label} HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    return res;
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<InferResponse> {
    const start = Date.now();
    try {
      const res = await this.post({
        model: this.cfg.model,
        messages: this.toOpenAiMessages(messages),
        stream: false,
        ...(options?.json ? { response_format: { type: 'json_object' } } : {}),
      });
      const data = (await res.json()) as ChatCompletionResponse;
      const text = data.choices?.[0]?.message?.content ?? '';
      return { text, durationMs: Date.now() - start };
    } catch (error) {
      log.error({ err: error, model: this.cfg.label }, 'remote LLM generate failed');
      throw new Error('LLM generation failed');
    }
  }

  async *generateStream(messages: ChatMessage[]): AsyncGenerator<string, void, unknown> {
    let res;
    try {
      res = await this.post({
        model: this.cfg.model,
        messages: this.toOpenAiMessages(messages),
        stream: true,
      });
    } catch (error) {
      log.error({ err: error, model: this.cfg.label }, 'remote LLM generateStream failed');
      throw new Error('LLM generation failed at infrastructure layer');
    }
    if (!res.body) throw new Error('LLM generation failed at infrastructure layer');

    // Parse the SSE stream: `data: {json}` lines, terminated by `data: [DONE]`. Buffer across
    // chunk boundaries since a single SSE event can be split over multiple network reads.
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const evt = JSON.parse(payload) as ChatCompletionResponse;
          const token = evt.choices?.[0]?.delta?.content;
          if (token) yield token;
        } catch {
          // partial/keep-alive line — ignore and wait for more data
        }
      }
    }
  }
}
