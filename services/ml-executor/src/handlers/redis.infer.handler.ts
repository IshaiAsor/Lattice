import { createLogger } from '@lattice/logger';
import { INFER_CHANNELS } from '@lattice/ioredis';
import type { InferJobPayload, InferChunk } from '@lattice/ml';
import { getModel, modelKey } from '../models';
import { createRedisClient } from '../redis/pubsub';
import type { ILlmProvider } from './ILlmProvider';
import type { IVlmProvider } from './IVlmProvider';
import { OllamaProviderService } from './ollama-provider.service';
import { OnnxVlmProvider } from './onnx-provider.service';
import type { ModelConfig } from '../models';

const log = createLogger('ml-executor:infer');

const jobSubscriber = createRedisClient(log, 'infer jobSubscriber');
const resultPublisher = createRedisClient(log, 'infer resultPublisher');

const llmCache = new Map<string, ILlmProvider>();
function getLlmProvider(modelName: string): ILlmProvider {
  let p = llmCache.get(modelName);
  if (!p) { p = new OllamaProviderService(modelName); llmCache.set(modelName, p); }
  return p;
}

const vlmCache = new Map<string, IVlmProvider>();
function getVlmProvider(cfg: ModelConfig): IVlmProvider {
  const key = modelKey(cfg);
  let p = vlmCache.get(key);
  if (!p) { p = new OnnxVlmProvider(cfg); vlmCache.set(key, p); }
  return p;
}

export async function initInferWorker(): Promise<void> {
  await jobSubscriber.subscribe(INFER_CHANNELS.INFER_JOBS);
  log.info('infer worker listening on Redis');

  jobSubscriber.on('message', async (channel, message) => {
    if (channel !== INFER_CHANNELS.INFER_JOBS) return;

    const job = JSON.parse(message) as InferJobPayload;
    const { requestId, model: modelId, messages, stream } = job;
    const out = `${INFER_CHANNELS.INFER_RESPONSE}${requestId}`;
    const emit = (chunk: InferChunk) => resultPublisher.publish(out, JSON.stringify(chunk));

    try {
      const cfg = getModel(modelId.kind, modelId.name, modelId.version);
      if (!cfg) throw new Error(`model ${modelId.kind}/${modelId.name}/${modelId.version} not found`);

      if (cfg.kind === 'vlm') {
        const start = Date.now();
        const detections = await getVlmProvider(cfg).detect(messages);
        await emit({ type: 'result', result: { detections, durationMs: Date.now() - start } });
      } else {
        if (!cfg.ollamaModel) throw new Error(`llm ${cfg.name} has no ollamaModel`);
        const provider = getLlmProvider(cfg.ollamaModel);
        if (stream) {
          for await (const text of provider.generateStream(messages)) {
            await emit({ type: 'token', text });
          }
        } else {
          const result = await provider.generate(messages);
          await emit({ type: 'result', result });
        }
      }
      await emit({ type: 'done' });
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      log.error({ error, requestId, modelId }, 'infer job error');
      await emit({ type: 'error', message: errMessage });
      await emit({ type: 'done' });
    }
  });
}
