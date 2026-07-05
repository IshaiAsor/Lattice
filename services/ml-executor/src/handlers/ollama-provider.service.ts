import { Ollama } from 'ollama';
import type { Message } from 'ollama';
import { Agent, fetch as undiciFetch } from 'undici';
import { createLogger } from '@lattice/logger';
import type { ChatMessage, InferResponse } from '@lattice/ml';
import { env } from '../config/env.config';
import type { GenerateOptions, ILlmProvider } from './ILlmProvider';

const log = createLogger('ml-executor:llm');

// Node's global fetch defaults to a 5-minute headers timeout, too short for VLM inference
// against a real image + full context. Route Ollama's client through undici directly so we
// can raise it.
const ollamaAgent = new Agent({ headersTimeout: env.llmTimeoutMs, bodyTimeout: env.llmTimeoutMs });

export class OllamaProviderService implements ILlmProvider {
  private readonly client: Ollama;

  constructor(private readonly modelName: string) {
    this.client = new Ollama({
      host: env.ollamaUrl,
      fetch: (input, init) =>
        undiciFetch(input as string, {
          ...init,
          dispatcher: ollamaAgent,
        }) as unknown as Promise<Response>,
    });
  }

  private toOllamaMessages(messages: ChatMessage[]): Message[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.image ? { images: [m.image] } : {}),
    }));
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<InferResponse> {
    const start = Date.now();
    try {
      const res = await this.client.chat({
        model: this.modelName,
        messages: this.toOllamaMessages(messages),
        stream: false,
        ...(options?.json ? { format: 'json' } : {}),
        options: { num_ctx: env.llmNumCtx },
      });
      return { text: res.message.content, durationMs: Date.now() - start };
    } catch (error) {
      log.error({ err: error, model: this.modelName }, 'LLM generate failed');
      throw new Error('LLM generation failed');
    }
  }

  async *generateStream(messages: ChatMessage[]): AsyncGenerator<string, void, unknown> {
    try {
      const stream = await this.client.chat({
        model: this.modelName,
        messages: this.toOllamaMessages(messages),
        stream: true,
        options: { num_ctx: env.llmNumCtx },
      });
      for await (const chunk of stream) {
        yield chunk.message.content;
      }
    } catch (error) {
      log.error({ err: error, model: this.modelName }, 'LLM generateStream failed');
      throw new Error('LLM generation failed at infrastructure layer');
    }
  }
}
