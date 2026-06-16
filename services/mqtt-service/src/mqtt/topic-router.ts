import { createLogger } from '@lattice/logger';
import { parseTopic, ParsedTopic } from './topic-parser';

const log = createLogger('mqtt-service:router');

export interface RouteContext {
  topic: string;
  parsed: ParsedTopic;
  payload: Buffer;
}

export type HandlerFn = (ctx: RouteContext) => Promise<void>;

interface Route {
  regex: RegExp;
  handler: HandlerFn;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.^${}()|[\]\\]/g, '\\$&') // escape regex specials except + and #
    .replace(/\+/g, '[^/]+')               // MQTT single-level wildcard
    .replace(/#/g, '.+');                  // MQTT multi-level wildcard
  return new RegExp(`^${escaped}$`);
}

export class TopicRouter {
  private readonly routes: Route[] = [];

  register(pattern: string, handler: HandlerFn): void {
    this.routes.push({ regex: patternToRegex(pattern), handler });
  }

  async route(topic: string, payload: Buffer): Promise<void> {
    for (const { regex, handler } of this.routes) {
      if (!regex.test(topic)) continue;

      const parsed = parseTopic(topic);
      if (!parsed) {
        log.warn({ topic }, 'topic matched pattern but failed to parse');
        return;
      }

      try {
        await handler({ topic, parsed, payload });
      } catch (err) {
        log.error({ err, topic }, 'handler threw an error');
      }
      return;
    }

    log.debug({ topic }, 'no handler matched topic');
  }
}
