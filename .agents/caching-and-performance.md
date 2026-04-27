# Caching and Performance in LocalAI

This guide covers caching strategies, performance tuning, and optimization techniques used throughout LocalAI.

## Overview

LocalAI uses several layers of caching to reduce latency and resource usage:

1. **Model cache** — keeps loaded models in memory to avoid repeated disk I/O
2. **Request-level cache** — deduplicates identical concurrent requests
3. **KV cache** (backend-specific) — prompt token caching inside llama.cpp and similar backends

---

## Model Cache

Models are loaded once and reused across requests. The cache is managed by `pkg/model/loader.go`.

```go
// ModelLoader holds loaded backends keyed by model name + options hash.
type ModelLoader struct {
    mu      sync.RWMutex
    models  map[string]*ModelState
    options LoaderOptions
}

type ModelState struct {
    Backend  BackendClient
    LoadedAt time.Time
    LastUsed time.Time
    RefCount int32
}
```

### Cache Eviction

Models are evicted when:
- `single_active_backend: true` is set in the model config (only one model loaded at a time)
- The process receives `SIGUSR1` (forces full reload)
- Explicit `/models/unload` API call is made

To keep a model warm permanently, set:

```yaml
# models/my-model.yaml
name: my-model
preload: true
```

---

## Request Deduplication

Identical in-flight requests are collapsed into a single backend call using `singleflight`:

```go
import "golang.org/x/sync/singleflight"

var sfGroup singleflight.Group

func (ml *ModelLoader) LoadWithDedup(modelName string, opts ...Option) (BackendClient, error) {
    key := cacheKey(modelName, opts...)
    result, err, _ := sfGroup.Do(key, func() (interface{}, error) {
        return ml.load(modelName, opts...)
    })
    if err != nil {
        return nil, err
    }
    return result.(BackendClient), nil
}
```

This prevents the "thundering herd" problem when many requests arrive before the first model load completes.

---

## KV Cache (llama.cpp)

llama.cpp maintains an internal KV cache for prompt tokens. Configure it via:

```yaml
# models/llama-model.yaml
parameters:
  n_ctx: 4096        # context window — larger = more RAM

llama_cpp_args:
  - "--cache-type-k": "q8_0"   # quantize K cache to save VRAM
  - "--cache-type-v": "q8_0"   # quantize V cache to save VRAM
```

### Prompt Caching

Enable prefix caching to reuse shared prompt prefixes across requests:

```yaml
llama_cpp_args:
  - "--cache-reuse": "256"  # reuse up to 256 tokens from previous prompt
```

This is especially useful for chat models with long system prompts.

---

## Parallel Request Handling

Control how many requests are processed simultaneously:

```yaml
# models/my-model.yaml
parallel_requests: true   # allow concurrent inference (requires backend support)
```

For llama.cpp, also set:

```yaml
llama_cpp_args:
  - "--parallel": "4"   # number of parallel decode slots
```

> **Warning:** Increasing parallelism increases VRAM usage proportionally.

---

## HTTP Response Caching

LocalAI does **not** cache HTTP responses by default because LLM outputs are non-deterministic. However, you can enable semantic caching via an external proxy (e.g., GPTCache, Redis) in front of LocalAI.

For deterministic use cases, set `temperature: 0` and `seed: 42` in your request — identical inputs will then produce identical outputs that an upstream cache can serve.

---

## Memory Profiling

To profile memory usage during development:

```bash
# Enable pprof endpoint (set in startup flags)
local-ai --pprof

# Capture heap profile
curl http://localhost:8080/debug/pprof/heap > heap.out
go tool pprof heap.out
```

Key metrics to watch:
- `process_resident_memory_bytes` — actual RAM used by the process
- `go_memstats_alloc_bytes` — Go heap allocations
- Backend-specific VRAM metrics (see `observability-and-metrics.md`)

---

## Performance Tuning Checklist

| Setting | Recommendation |
|---|---|
| `n_threads` | Set to physical CPU cores (not hyperthreads) |
| `n_gpu_layers` | Maximize for your VRAM budget (`-1` = all layers) |
| `f16_kv` | Enable for 2× KV cache memory reduction |
| `mmap` | Enable (`true`) for faster cold loads on SSD |
| `mlock` | Enable to prevent model pages from being swapped |
| `batch_size` | Increase (e.g., 512–2048) for throughput-oriented workloads |

```yaml
# Example high-performance config
name: llama-fast
mmap: true
mlock: true
parameters:
  model: llama-3-8b.Q4_K_M.gguf
  f16: true
  threads: 8
  gpu_layers: 35
  batch: 1024
  n_ctx: 8192
```

---

## See Also

- `model-configuration.md` — full model YAML reference
- `llama-cpp-backend.md` — llama.cpp-specific tuning
- `observability-and-metrics.md` — Prometheus metrics for cache hit rates
- `debugging-backends.md` — diagnosing slow load times
