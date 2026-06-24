# ml-router

Generic ML inference service for the Lattice platform. Handles both VLM (vision) and LLM
inference via two interfaces:

- **HTTP** — synchronous, direct inference (camera intake, admin tooling)
- **RabbitMQ consumer** — async pipeline stage processing; publishes results to `pipeline.stage.done.v1`

**Port:** 3002

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Status + loaded model list |
| POST | `/api/infer` | Run inference on a registered model |

### POST /api/infer

**VLM request:**
```json
{
  "kind": "vlm",
  "name": "yolo",
  "version": "v1",
  "input": { "image": "<base64-jpeg>" }
}
```

**LLM request:**
```json
{
  "kind": "llm",
  "name": "qwen",
  "version": "v1",
  "input": {
    "prompt": "Describe the state of this device.",
    "image": "<base64-jpeg>",
    "context": {}
  }
}
```

**Response (both):**
```json
{
  "output": { ... },
  "model": "vlm/yolo/v1",
  "duration_ms": 134
}
```

VLM output shape: `{ detections: [{ label, confidence, box? }] }`  
LLM output shape: `{ text: string }`

---

## Model registry (`models.json`)

Models are registered in `models.json` at the service root. Two backends are supported:

```json
[
  {
    "kind": "vlm",
    "name": "yolo",
    "version": "v1",
    "backend": "onnx",
    "modelFile": "yolo.onnx",
    "classes": ["Belum Matang", "Matang", "Rusak"]
  },
  {
    "kind": "llm",
    "name": "qwen",
    "version": "v1",
    "backend": "ollama",
    "ollamaModel": "qwen2.5vl:7b"
  }
]
```

- `backend: "onnx"` — loads `ONNX_MODELS_DIR/{modelFile}` at first inference (lazy, cached)
- `backend: "ollama"` — proxies to `OLLAMA_URL` (Ollama API)
- `classes` — maps ONNX output `class_id` integers to human-readable labels

---

## Included model: yolo/v1

YOLOv8-nano trained on lettuce health detection.

| Class ID | Label | Meaning |
|----------|-------|---------|
| 0 | Belum Matang | Immature |
| 1 | Matang | Mature |
| 2 | Rusak | Damaged |

- **Input:** 640×640 JPEG (auto-resized by the handler)
- **Model file:** `models/yolo.onnx` (9.8 MB)
- **Dataset:** 5170 images, Roboflow export, CC BY 4.0 — see `models/yolo-v1.README.txt`

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | HTTP listen port |
| `RABBITMQ_URL` | `amqp://localhost` | RabbitMQ connection |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `ONNX_MODELS_DIR` | `./models` | Directory containing `.onnx` files |
| `LOG_LEVEL` | `info` | Pino log level |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(unset)_ | OTel collector (no-op if unset) |

---

## Local development

```bash
# From repo root
npm install -w @lattice/ml-router
npm run build -w @lattice/logger && npm run build -w @lattice/otel && npm run build -w @lattice/queue
npm run dev -w @lattice/ml-router   # ts-node hot reload

# Or via compose (requires rabbitmq to be running)
docker compose up -d rabbitmq
docker compose up ml-router
```

Model file must be present at `models/yolo.onnx` for ONNX inference.  
Ollama must be running and have `qwen2.5vl:7b` pulled for LLM inference.

---

## RabbitMQ interface

On startup, `setupModelQueues()` asserts one queue per model entry in `models.json`:

```
q.pipeline.stage.vlm.yolo.v1
q.pipeline.stage.llm.qwen.v1
```

Each consumer receives a `PipelineStagePayload` from `@lattice/queue`, runs the handler,
then publishes a `PipelineStageDonePayload` to `pipeline.stage.done.v1`.

Required context fields per kind:
- **vlm:** `context.image` (base64 JPEG)
- **llm:** `context.prompt` (string); `context.image` and `context.sensor_data` optional
