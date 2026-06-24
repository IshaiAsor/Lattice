import { readFileSync } from 'fs';
import { resolve } from 'path';

export type ModelBackend = 'onnx' | 'ollama';

export interface ModelConfig {
  kind: 'vlm' | 'llm';
  name: string;
  version: string;
  backend: ModelBackend;
  modelFile?: string;    // onnx only
  ollamaModel?: string;  // ollama only
  classes?: string[];    // label names indexed by class_id (onnx output)
}

export type ModelKey = `${string}/${string}/${string}`;

export function modelKey(m: ModelConfig): ModelKey {
  return `${m.kind}/${m.name}/${m.version}`;
}

let _registry: Map<ModelKey, ModelConfig> | undefined;

export function loadRegistry(): Map<ModelKey, ModelConfig> {
  if (_registry) return _registry;
  const path = resolve(__dirname, '..', 'models.json');
  const entries = JSON.parse(readFileSync(path, 'utf8')) as ModelConfig[];
  _registry = new Map(entries.map((m) => [modelKey(m), m]));
  return _registry;
}

export function getModel(kind: string, name: string, version: string): ModelConfig | undefined {
  return loadRegistry().get(`${kind}/${name}/${version}` as ModelKey);
}

export function listModels(): string[] {
  return [...loadRegistry().keys()];
}
