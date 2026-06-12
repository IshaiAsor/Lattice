import express from 'express';
import { db } from '@lattice/prisma-client';
import { runVlmOnnx, runVlmOllama, VlmInput, VlmOllamaConfig } from '../handlers/vlm.handler';
import { runLlm, LlmModelConfig } from '../handlers/llm.handler';
import { createLogger } from '@lattice/logger';
import { inferenceDuration } from '../metrics';

const log    = createLogger('ml-router:infer');
const router = express.Router();

router.post('/', async (req, res) => {
  const { kind, name, version, input } = req.body as {
    kind: string; name: string; version: string; input: unknown;
  };

  if (!kind || !name || !version || input === undefined) {
    return res.status(400).json({ error: 'kind, name, version and input are required' });
  }
  log.debug({ kind, name, version });

  const t0 = Date.now();

  try {
    let output: unknown;

    if (kind === 'vlm') {
      // Check DB for model config — if endpoint present, route to Ollama; otherwise ONNX
      const model = await db.mlModel.findFirst({
        where: { kind: 'vlm', name, version },
        select: { config: true },
      });
      log.debug(model);
      const cfg = model?.config as VlmOllamaConfig | null;

      if (cfg?.endpoint) {
        output = await runVlmOllama(name, version, cfg, input as VlmInput);
      } else {  
        output = await runVlmOnnx(name, version, input as VlmInput);
      }
    } else if (kind === 'llm') {
      const model = await db.mlModel.findFirst({
        where: { kind: 'llm', name, version },
        select: { config: true },
      });
      if (!model) {
        return res.status(404).json({ error: `LLM model not registered: ${name}@${version}` });
      }
      const modelConfig = model.config as LlmModelConfig | null;
      if (!modelConfig?.endpoint) {
        return res.status(500).json({ error: `LLM model ${name}@${version} missing config.endpoint` });
      }
      output = await runLlm(name, version, modelConfig, input as Record<string, unknown>);
    } else {
      return res.status(400).json({ error: `Unsupported kind: ${kind}` });
    }

    const durationMs = Date.now() - t0;
    inferenceDuration.observe({ kind, name, version }, durationMs / 1000);
    log.debug({ kind, name, version, durationMs }, 'inference ok');

    res.json({ output, model: { kind, name, version }, duration_ms: durationMs });
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 500;
    const message = err instanceof Error ? err.message : 'Inference failed';
    log.error({ kind, name, version, err }, 'inference error');
    res.status(status).json({ error: message });
  }
});

export default router;
