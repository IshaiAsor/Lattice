import type { ModelConfig } from '../models';
import { modelKey } from '../models';
import type { ILlmProvider } from './ILlmProvider';
import { OllamaProviderService } from './ollama-provider.service';
import { OpenAICompatProviderService } from './openai-compat-provider.service';

// Single place that turns an LLM ModelConfig into a provider, dispatching on `backend`. All
// three transports (Redis, HTTP, queue) go through here so a new backend is wired once.
// Throws when the config is incomplete or a remote key is absent — callers already run this
// inside their per-request try/catch, so a missing key surfaces as a job error, never a crash.
export function createLlmProvider(cfg: ModelConfig): ILlmProvider {
  const label = modelKey(cfg);
  switch (cfg.backend) {
    case 'ollama':
      if (!cfg.ollamaModel) throw new Error(`llm ${cfg.name} has no ollamaModel`);
      return new OllamaProviderService(cfg.ollamaModel);
    case 'openai': {
      if (!cfg.baseUrl || !cfg.apiModel || !cfg.apiKeyEnv)
        throw new Error(`llm ${cfg.name} needs baseUrl, apiModel and apiKeyEnv`);
      const apiKey = process.env[cfg.apiKeyEnv];
      if (!apiKey) throw new Error(`llm ${cfg.name} missing API key env ${cfg.apiKeyEnv}`);
      return new OpenAICompatProviderService({
        baseUrl: cfg.baseUrl.replace(/\/$/, ''),
        apiKey,
        model: cfg.apiModel,
        label,
      });
    }
    default:
      throw new Error(`backend ${cfg.backend} is not an LLM backend`);
  }
}
