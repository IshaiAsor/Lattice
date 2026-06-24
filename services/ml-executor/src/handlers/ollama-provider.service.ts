import { Ollama } from 'ollama';
import type { Message } from 'ollama';
import { createLogger } from '@lattice/logger';
import type { ChatMessage, InferResponse } from '@lattice/ml';
import { env } from '../config/env.config';
import type { ILlmProvider } from './ILlmProvider';

const log = createLogger('ml-executor:llm');

export class OllamaProviderService implements ILlmProvider {
  private readonly client: Ollama;

  constructor(private readonly modelName: string) {
    this.client = new Ollama({ host: env.ollamaUrl });
  }

  private toOllamaMessages(messages: ChatMessage[]): Message[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.image ? { images: [m.image] } : {}),
    }));
  }

  async generate(messages: ChatMessage[]): Promise<InferResponse> {
    const start = Date.now();
    try {
      const res = await this.client.chat({
        model: this.modelName,
        messages: this.toOllamaMessages(messages),
        stream: false,
        options: { num_ctx: 4096 },
      });
      return { text: res.message.content, durationMs: Date.now() - start };
    } catch (error) {
      log.error({ error, model: this.modelName }, 'LLM generate failed');
      throw new Error('LLM generation failed');
    }
  }

  async *generateStream(messages: ChatMessage[]): AsyncGenerator<string, void, unknown> {
    try {
      const stream = await this.client.chat({
        model: this.modelName,
        messages: this.toOllamaMessages(messages),
        stream: true,
        options: { num_ctx: 4096 },
      });
      for await (const chunk of stream) {
        yield chunk.message.content;
      }
    } catch (error) {
      throw new Error('LLM generation failed at infrastructure layer');
    }
  }
}
