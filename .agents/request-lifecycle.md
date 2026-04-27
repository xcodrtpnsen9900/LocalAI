# Request Lifecycle in LocalAI

This document describes how a request flows through LocalAI from the HTTP layer down to the backend and back.

## Overview

```
HTTP Request
    │
    ▼
[Fiber Router]
    │
    ▼
[Auth Middleware]  ← API key validation
    │
    ▼
[Route Handler]   ← e.g. /v1/chat/completions
    │
    ▼
[Request Validation]
    │
    ▼
[Model Resolution] ← resolve model name → config
    │
    ▼
[Backend Selection] ← pick gRPC backend process
    │
    ▼
[gRPC Call]        ← stream or unary
    │
    ▼
[Response Marshaling]
    │
    ▼
HTTP Response
```

## 1. HTTP Layer (Fiber)

Routes are registered in `core/http/` using the Fiber framework. Each OpenAI-compatible endpoint (e.g. `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`) maps to a handler function.

See `.agents/api-endpoints-and-auth.md` for how to register new routes.

## 2. Authentication Middleware

If `LOCALAI_API_KEY` is set, all requests must include:

```
Authorization: Bearer <api-key>
```

The middleware short-circuits with `401 Unauthorized` if the key is missing or invalid.

## 3. Request Validation

Handlers unmarshal the JSON body into a request struct (e.g. `schema.OpenAIRequest`). Validation errors return `400 Bad Request` with a descriptive message.

## 4. Model Resolution

The model name from the request is resolved to a `ModelConfig` via the config loader:

```go
// Lookup by model name or alias
cfg, err := cl.GetConfigTemplateByName(modelName)
if err != nil {
    // fall back to default config or return 404
}
```

Config files live in the models directory (`/models/*.yaml`). See `.agents/model-configuration.md` for the full schema.

## 5. Backend Selection

Based on the resolved config (specifically the `backend` field), LocalAI selects the appropriate gRPC backend process. Backends are managed by `core/backend/`:

- `llama-cpp` — GGUF models via llama.cpp
- `whisper` — audio transcription
- `stablediffusion` — image generation
- `bert-embeddings` — embeddings
- Custom backends registered via the gallery

If the backend process is not running, it is started on demand and cached for reuse.

## 6. gRPC Communication

All backend communication uses gRPC (protobuf). The main service definition is in `pkg/grpc/proto/`.

Key RPC methods:

| Method | Used For |
|--------|----------|
| `Predict` | Text completion (unary) |
| `PredictStream` | Streaming completions |
| `Embedding` | Vector embeddings |
| `GenerateImage` | Image generation |
| `AudioTranscription` | Whisper STT |
| `LoadModel` | Load a model into memory |

### Streaming Example

```go
stream, err := client.PredictStream(ctx, &pb.PredictOptions{
    Prompt: prompt,
    // ... generation params
})
for {
    resp, err := stream.Recv()
    if err == io.EOF {
        break
    }
    // write SSE chunk to HTTP response
    fmt.Fprintf(w, "data: %s\n\n", marshalChunk(resp))
}
```

## 7. Response Marshaling

Backend responses are converted into OpenAI-compatible response structs and serialized to JSON. For streaming endpoints, responses are sent as Server-Sent Events (SSE):

```
data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]
```

## 8. Observability

Each stage emits OpenTelemetry spans. See `.agents/observability-and-metrics.md` for how to instrument new code paths.

Key span names follow the pattern:
- `localai.http.<endpoint>` — HTTP handler span
- `localai.backend.<name>` — backend gRPC call span
- `localai.model.load` — model loading span

## Error Handling Conventions

| Scenario | HTTP Status |
|----------|-------------|
| Invalid JSON body | 400 |
| Unknown model | 404 |
| Auth failure | 401 |
| Backend unavailable | 503 |
| Inference error | 500 |

Always return errors in OpenAI error format:

```json
{
  "error": {
    "message": "model 'gpt-5' not found",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

## Tips for Debugging a Stuck Request

1. Enable debug logging: `LOG_LEVEL=debug`
2. Check if the backend process is running: `ps aux | grep backend-assets`
3. Inspect gRPC errors in logs — they often contain the root cause
4. Use the `/readyz` and `/healthz` endpoints to verify backend health
5. See `.agents/debugging-backends.md` for backend-specific debugging steps
