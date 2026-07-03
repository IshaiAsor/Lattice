export interface ParsedLlmOutput {
  output: Record<string, unknown>;
  error?: string;
}

// Ollama's format:'json' mode guarantees syntactically valid JSON, but the model can still
// wrap it in a fenced code block, or return a JSON value that isn't an object (e.g. a bare
// array/string). Strip fences defensively and require an object — the fields inside are
// pipeline-specific (command_exec expects user_device_action_id/value, other pipelines will
// expect other shapes), so this stays agnostic and just guarantees a spreadable object.
export function parseLlmOutput(text: string, durationMs: number): ParsedLlmOutput {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { output: { text, durationMs }, error: 'LLM response was not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { output: { text, durationMs }, error: 'LLM response was valid JSON but not an object' };
  }

  return { output: { ...(parsed as Record<string, unknown>), text, durationMs } };
}
