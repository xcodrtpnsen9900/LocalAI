# Observability and Metrics in LocalAI

This guide covers how to add metrics, logging, and tracing to LocalAI components.

## Overview

LocalAI uses the following observability stack:
- **Prometheus** for metrics collection
- **OpenTelemetry** for distributed tracing
- **Zerolog** for structured logging

## Logging

### Using the Logger

LocalAI uses `zerolog` for structured, leveled logging. Import and use it as follows:

```go
import (
    "github.com/rs/zerolog/log"
)

func MyFunction(modelName string) error {
    log.Info().Str("model", modelName).Msg("Loading model")
    log.Debug().Str("model", modelName).Int("threads", 4).Msg("Model config details")
    log.Error().Err(err).Str("model", modelName).Msg("Failed to load model")
    return nil
}
```

### Log Levels

| Level   | Usage                                              |
|---------|----------------------------------------------------|
| `Trace` | Very verbose internal state (disabled in prod)     |
| `Debug` | Developer-facing detail, enabled with `--debug`    |
| `Info`  | Normal operational messages                        |
| `Warn`  | Recoverable issues or deprecation notices          |
| `Error` | Errors that affect a single request                |
| `Fatal` | Unrecoverable errors that terminate the process    |

### Structured Fields

Always prefer structured fields over string interpolation:

```go
// Good
log.Info().Str("backend", backendName).Str("model", modelName).Msg("Backend initialized")

// Avoid
log.Info().Msgf("Backend %s initialized with model %s", backendName, modelName)
```

## Prometheus Metrics

### Existing Metrics

LocalAI exposes metrics at `/metrics`. Key metrics include:

- `localai_inference_duration_seconds` — histogram of inference latency
- `localai_model_load_duration_seconds` — time to load a model
- `localai_active_requests` — gauge of in-flight requests
- `localai_tokens_generated_total` — counter of tokens produced
- `localai_requests_total` — counter labeled by model, backend, and status

### Adding a New Metric

Define metrics in `pkg/metrics/metrics.go`:

```go
var (
    MyOperationDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "localai_my_operation_duration_seconds",
            Help:    "Duration of my custom operation in seconds.",
            Buckets: prometheus.DefBuckets,
        },
        []string{"model", "backend"},
    )
)

func init() {
    prometheus.MustRegister(MyOperationDuration)
}
```

Record observations in your handler or backend:

```go
timer := prometheus.NewTimer(metrics.MyOperationDuration.WithLabelValues(modelName, backendName))
defer timer.ObserveDuration()
```

### Labels

Use consistent label names across metrics:
- `model` — the model name or ID
- `backend` — the backend name (e.g., `llama-cpp`, `whisper`)
- `status` — `success` or `error`

Avoid high-cardinality labels (e.g., user IDs, full prompt text).

## OpenTelemetry Tracing

### Enabling Tracing

Set the following environment variables to enable OTLP export:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=localai
```

### Instrumenting a Function

```go
import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
)

var tracer = otel.Tracer("localai/mypackage")

func MyTracedFunction(ctx context.Context, modelName string) error {
    ctx, span := tracer.Start(ctx, "MyTracedFunction")
    defer span.End()

    span.SetAttributes(
        attribute.String("model", modelName),
    )

    // ... your logic ...

    if err != nil {
        span.RecordError(err)
        return err
    }
    return nil
}
```

### Propagating Context

Always pass `context.Context` as the first argument through call chains so trace context propagates correctly from HTTP handlers down to backend calls.

## Health Endpoints

LocalAI exposes:
- `GET /healthz` — liveness probe (returns 200 if the process is running)
- `GET /readyz` — readiness probe (returns 200 once models are loaded and ready)

When adding a new backend or long-running initialization step, hook into the readiness gate in `pkg/startup/startup.go` so Kubernetes does not route traffic prematurely.

## Best Practices

1. **Log at the boundary** — log when entering/exiting major operations, not inside tight loops.
2. **Don't log secrets** — never log API keys, tokens, or user prompt content at `Info` or above.
3. **Use context** — pass `ctx` to enable trace propagation and cancellation.
4. **Keep cardinality low** — avoid dynamic label values in Prometheus metrics.
5. **Test metrics** — use `prometheus/testutil` to assert metric values in unit tests.
