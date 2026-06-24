import type { ChatMessage, Detection } from '@lattice/ml';

export interface IVlmProvider {
  detect(messages: ChatMessage[]): Promise<Detection[]>;
}
