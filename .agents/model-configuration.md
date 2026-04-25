# Model Configuration Guide

This document describes how to configure models in LocalAI, including YAML configuration files, model parameters, and backend-specific settings.

## Overview

LocalAI uses YAML configuration files to define how models are loaded and used. Each model can have its own configuration file placed in the models directory.

## Configuration File Structure

A model configuration file (`model-name.yaml`) typically looks like:

```yaml
name: my-model
backend: llama-cpp
parameters:
  model: models/my-model.gguf
  context_size: 4096
  threads: 4
  gpu_layers: 35

# Template configuration
template:
  chat: |
    {{.Input}}
  completion: |
    {{.Input}}

# Inference parameters
f16: true
mmap: true
mlock: false

# Prompt templates
system_prompt: "You are a helpful assistant."

# Stop words
stop_words:
  - "</s>"
  - "[INST]"
  - "[/INST]"
```

## Key Configuration Fields

### `name`
The model name used in API requests (e.g., in `model` field of OpenAI-compatible requests).

### `backend`
Specifies which backend to use for inference. Available backends:
- `llama-cpp` — for GGUF models
- `whisper` — for audio transcription
- `stablediffusion` — for image generation
- `bark` — for text-to-speech
- `transformers` — for HuggingFace models
- `grpc` — for custom gRPC backends

### `parameters`
Backend-specific parameters:

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Path to the model file (relative to models dir) |
| `context_size` | int | Maximum context window size |
| `threads` | int | Number of CPU threads |
| `gpu_layers` | int | Number of layers to offload to GPU |
| `batch_size` | int | Batch size for prompt processing |
| `seed` | int | Random seed (-1 for random) |

### `f16`
Enable 16-bit floating point precision. Reduces memory usage.

### `mmap`
Enable memory-mapped files. Recommended for large models.

### `mlock`
Lock model in RAM to prevent swapping. Requires sufficient RAM.

## Template Syntax

LocalAI uses Go templates for prompt formatting. Available variables:

- `{{.Input}}` — the user input
- `{{.SystemPrompt}}` — the system prompt
- `{{.History}}` — conversation history
- `{{.Functions}}` — available functions (for function calling)

### Chat Template Example (LLaMA 2)

```yaml
template:
  chat: |
    [INST] <<SYS>>
    {{.SystemPrompt}}
    <</SYS>>
    {{.Input}} [/INST]
```

### Chat Template Example (ChatML)

```yaml
template:
  chat: |
    <|im_start|>system
    {{.SystemPrompt}}<|im_end|>
    <|im_start|>user
    {{.Input}}<|im_end|>
    <|im_start|>assistant
```

## Multiple Model Files

For models split across multiple files:

```yaml
parameters:
  model: models/my-model-00001-of-00002.gguf
```

llama.cpp automatically detects and loads split files.

## Rope Scaling

For models with extended context via RoPE scaling:

```yaml
rope_scaling:
  type: linear  # or "yarn"
  factor: 2.0
```

## GPU Configuration

```yaml
# Offload all layers to GPU
parameters:
  gpu_layers: 999

# Multi-GPU split (llama-cpp)
tensor_split: "0.5,0.5"
```

## Environment Variables

Configuration values can reference environment variables:

```yaml
parameters:
  model: ${MODELS_PATH}/my-model.gguf
```

## Validation

When LocalAI starts, it validates all configuration files. Common errors:

- `model file not found` — check the model path
- `backend not available` — ensure the backend binary is compiled
- `invalid template` — check Go template syntax

## Tips

1. **Start with fewer GPU layers** and increase gradually to avoid OOM errors.
2. **Use `mmap: true`** for models larger than available RAM.
3. **Set `threads`** to the number of physical CPU cores (not hyperthreads).
4. **Test templates** with simple prompts before deploying.
5. **Use the gallery** for pre-configured community models (see `adding-gallery-models.md`).

## Related Files

- `.agents/adding-backends.md` — how to add new backends
- `.agents/adding-gallery-models.md` — publishing model configs to the gallery
- `.agents/llama-cpp-backend.md` — llama.cpp specific configuration
