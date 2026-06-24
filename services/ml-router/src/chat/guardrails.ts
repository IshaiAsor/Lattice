import type { ChatMessage } from '@lattice/ml';

// The orchestrator owns the system prompt (moved here from the executor, which is now generic).
export const SYSTEM_PROMPT: ChatMessage = {
  role: 'system',
  content: 'You are a clean, secure enterprise core engine assistant. Respond using strict Markdown.',
};

// Strip any client-supplied system messages — only the orchestrator may set the system role
// (prompt-injection guard). Enrichment system messages are added separately, after this.
export function sanitizeClientMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== 'system');
}
