import type { HandlerFn } from '../mqtt/topic-router';

export interface MqttHandler {
  pattern: string;
  handle: HandlerFn;
}
