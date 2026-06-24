import { createLogger } from '@lattice/logger';
import { CHAT_CHANNELS, INFER_CHANNELS } from '@lattice/ioredis';
import type { ChatIntentPayload, InferJobPayload, InferChunk, ChatMessage } from '@lattice/ml';
import { createRedisClient } from '../redis/pubsub';
import { getPlan } from '../plans/registry';
import { getEnricher } from '../enrich/enricher';
import { SYSTEM_PROMPT, sanitizeClientMessages } from '../chat/guardrails';
import { processResponse } from '../audit/response.processor';

const log = createLogger('ml-router:chat');

// Unknown/empty chatMode falls back to this plan (preserves the prior default-to-free UX).
const DEFAULT_CHAT_MODE = 'free';

const intentSub = createRedisClient(log, 'intent subscriber');
const responseSub = createRedisClient(log, 'response subscriber');
const publisher = createRedisClient(log, 'publisher');

// In-flight chats, keyed by the infer:response channel we subscribed to for that request.
interface Inflight {
  requestId: string;
  userId: string;
  chatMode: string;
  clientChannel: string; // chat:response:<id> that socket-server listens on
  text: string;          // accumulated answer, for audit at completion
}
const inflight = new Map<string, Inflight>();

export async function initChatWorker(): Promise<void> {
  await intentSub.subscribe(CHAT_CHANNELS.CHAT_INTENT);
  log.info('chat worker listening on Redis');

  // Response side: relay executor chunks (infer:response:<id>) → socket-server (chat:response:<id>),
  // accumulating the full answer and auditing it once the stream completes.
  responseSub.on('message', async (channel, raw) => {
    const ctx = inflight.get(channel);
    if (!ctx) return;

    let chunk: InferChunk;
    try {
      chunk = JSON.parse(raw) as InferChunk;
    } catch {
      return;
    }

    switch (chunk.type) {
      case 'token':
        ctx.text += chunk.text;
        await publisher.publish(ctx.clientChannel, chunk.text);
        break;
      case 'result':
        // Single-shot answer (stream:false LLM). VLM detections have no text → nothing to relay.
        if (chunk.result.text) {
          ctx.text += chunk.result.text;
          await publisher.publish(ctx.clientChannel, chunk.result.text);
        }
        break;
      case 'error':
        await publisher.publish(ctx.clientChannel, 'An error occurred during generation.');
        break;
      case 'done':
        try {
          await processResponse(ctx.requestId, ctx.chatMode, ctx.text);
        } catch (err) {
          log.error({ err, requestId: ctx.requestId }, 'response processing failed');
        }
        await publisher.publish(ctx.clientChannel, '[DONE]');
        await responseSub.unsubscribe(channel);
        inflight.delete(channel);
        break;
    }
  });

  // Request side: edge intent → plan → model + enrichment → dispatch a generic infer job.
  intentSub.on('message', async (channel, message) => {
    if (channel !== CHAT_CHANNELS.CHAT_INTENT) return;

    const intent = JSON.parse(message) as ChatIntentPayload;
    const chatMode = intent.chatMode || DEFAULT_CHAT_MODE;
    const clientChannel = `${CHAT_CHANNELS.CHAT_RESPONSE}${intent.requestId}`;

    try {
      const plan = getPlan(chatMode) ?? getPlan(DEFAULT_CHAT_MODE);
      if (!plan) throw new Error(`no plan for chatMode '${chatMode}'`);

      const inferStage = plan.stages.find((s) => s.type === 'infer');
      if (!inferStage || inferStage.type !== 'infer') {
        throw new Error(`plan '${plan.chatMode}' has no infer stage`);
      }

      // Run enrich stages → system messages, then assemble: our system prompt, enrichment,
      // then the sanitized client turns (client system messages stripped).
      const enrichMsgs: ChatMessage[] = [];
      for (const stage of plan.stages) {
        if (stage.type === 'enrich') {
          enrichMsgs.push(...(await getEnricher(stage.enricher).enrich(intent)));
        }
      }
      const messages = [SYSTEM_PROMPT, ...enrichMsgs, ...sanitizeClientMessages(intent.messages)];

      const job: InferJobPayload = {
        requestId: intent.requestId,
        model: inferStage.model,
        messages,
        stream: intent.stream,
      };

      // Subscribe to the executor's response BEFORE publishing the job, so no chunk is missed.
      const responseChannel = `${INFER_CHANNELS.INFER_RESPONSE}${intent.requestId}`;
      inflight.set(responseChannel, {
        requestId: intent.requestId,
        userId: intent.userId,
        chatMode,
        clientChannel,
        text: '',
      });
      await responseSub.subscribe(responseChannel);
      await publisher.publish(INFER_CHANNELS.INFER_JOBS, JSON.stringify(job));

      log.info(
        { requestId: intent.requestId, chatMode, model: inferStage.model, stream: intent.stream, enriched: enrichMsgs.length },
        'chat intent dispatched',
      );
    } catch (error) {
      log.error({ error, requestId: intent.requestId }, 'chat routing failed');
      await publisher.publish(clientChannel, 'Failed to route chat request.');
      await publisher.publish(clientChannel, '[DONE]');
    }
  });
}
