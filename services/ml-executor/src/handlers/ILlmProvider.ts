import type { ChatMessage, InferResponse } from '@lattice/ml';

export interface ILlmProvider {
  generate(messages: ChatMessage[]): Promise<InferResponse>;
  generateStream(messages: ChatMessage[]): AsyncGenerator<string, void, unknown>;
}