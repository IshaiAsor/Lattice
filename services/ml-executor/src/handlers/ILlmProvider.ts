import type { ChatMessage, InferResponse } from '@lattice/ml';

export interface GenerateOptions {
  // Forces the model to emit a syntactically valid JSON blob (Ollama's structured-output
  // mode). Only meaningful for the non-streaming path — pipeline stages need it, interactive
  // chat doesn't, so callers opt in explicitly rather than it being the default.
  json?: boolean;
}

export interface ILlmProvider {
  generate(messages: ChatMessage[], options?: GenerateOptions): Promise<InferResponse>;
  generateStream(messages: ChatMessage[]): AsyncGenerator<string, void, unknown>;
}