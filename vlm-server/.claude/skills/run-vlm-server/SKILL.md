# VLM Server

AI microservice that runs ONNX-based YOLOv8 inference on plant images to detect
lettuce health states and emit hydroponic farm control instructions.

## Overview

- **Language:** TypeScript (ESM, run via ts-node)
- **Framework:** Express 5
- **Model:** YOLOv8-nano ONNX (`best.onnx`) — 3 detection classes:
  - `Belum Matang` — Immature
  - `Matang` — Mature
  - `Rusak` — Damaged
- **Port:** 3000
- **API docs:** http://localhost:3000/api/docs (Swagger UI)

## Prerequisites

- Node.js 22+
- `best.onnx` must exist in the service root (`vlm-server/best.onnx`)
- Run `npm install` in `vlm-server/` before starting

## Commands

```powershell
# From vlm-server/
npm install       # install dependencies
npm start         # production (node --loader ts-node/esm server.ts)
npm run dev       # development (ts-node --esm server.ts)
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Service health check — returns `{status, uptime, timestamp}` |
| POST | `/api/v1/analyze` | Run inference on a JPEG image — returns detections + farm action |
| GET | `/api/docs` | Swagger UI — interactive API documentation |

### POST /api/v1/analyze

- **Content-Type:** `image/jpeg` (raw binary body — same format ESP32 cameras send)
- **Response:**
  ```json
  {
    "success": true,
    "timestamp": "2026-05-31T10:00:00.000Z",
    "detections_found": 4,
    "detections": [
      { "classId": 1, "className": "Matang", "confidence": 0.94, "box": { "x1": 12, "y1": 30, "x2": 200, "y2": 180 } }
    ],
    "farm_control_action": "maintain_current_state"
  }
  ```

### Farm control actions

| Action | Trigger condition |
|--------|------------------|
| `maintain_current_state` | Default |
| `flush_nutrients_and_increase_watering` | More than 2 damaged plants detected |
| `extend_light_cycle_brightness` | More than 10 immature plants detected |

## Training

See [training/](../training/) for the full retraining pipeline (Python + YOLOv8).
Run "Train VLM Server Model" from VS Code Run & Debug to retrain and export a new `best.onnx`.

## Docker

```powershell
# Build locally
docker build -t vlm-server .

# Or via compose (port 3002)
docker compose up vlm-server
```

## Smoke Test

Run `smoke.ps1` from this directory to verify the service starts and responds correctly.
