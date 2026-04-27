# Troubleshooting Common Issues in LocalAI

This guide covers the most frequently encountered issues when working with LocalAI and how to resolve them.

---

## Model Loading Failures

### Symptom
Model fails to load with errors like `failed to load model`, `context allocation failed`, or `backend not found`.

### Causes & Fixes

**1. Incorrect model configuration**
Ensure your model YAML config specifies the correct backend:
```yaml
name: my-model
backend: llama-cpp
parameters:
  model: models/my-model.gguf
```
See `.agents/model-configuration.md` for full config reference.

**2. Missing or corrupt model file**
```bash
# Verify the model file exists and is not truncated
ls -lh models/
sha256sum models/my-model.gguf
```

**3. Wrong backend selected**
Check that the backend binary exists under `backend-assets/` and is executable:
```bash
ls -lh backend-assets/grpc/
file backend-assets/grpc/llama-cpp
```

**4. Insufficient memory**
Reduce context size or number of GPU layers in your model config:
```yaml
parameters:
  context_size: 2048
f16: true
gpu_layers: 0  # Set to 0 to run fully on CPU
```

---

## API Returns 500 or Empty Response

### Symptom
Requests to `/v1/chat/completions` or other endpoints return HTTP 500 or an empty body.

### Debugging Steps

1. **Enable verbose logging** by starting LocalAI with `--debug`:
   ```bash
   ./local-ai --debug --models-path ./models
   ```

2. **Check the gRPC backend process** is running:
   ```bash
   ps aux | grep grpc
   ```

3. **Test the endpoint directly** with curl:
   ```bash
   curl -s http://localhost:8080/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"my-model","messages":[{"role":"user","content":"Hello"}]}'
   ```

4. **Validate model is loaded** via the models endpoint:
   ```bash
   curl http://localhost:8080/v1/models
   ```

See `.agents/api-endpoints-and-auth.md` for endpoint details.

---

## Backend Process Crashes / Restarts

### Symptom
Logs show repeated `backend process exited`, `restarting backend`, or gRPC connection errors.

### Common Causes

- **CUDA/GPU driver mismatch**: Ensure your CUDA toolkit version matches the compiled backend.
- **Segfault in llama.cpp**: Usually caused by unsupported model format or quantization type. Try a different GGUF variant.
- **Out-of-memory (OOM)**: Reduce `gpu_layers` or `context_size`.

```bash
# Check system memory and GPU memory
free -h
nvidia-smi  # if using NVIDIA GPU
```

Refer to `.agents/debugging-backends.md` for attaching a debugger to the backend process.

---

## Authentication Errors (401 Unauthorized)

### Symptom
API requests return `401 Unauthorized` even with a valid key.

### Fix
Ensure the `Authorization` header uses the `Bearer` scheme:
```bash
curl http://localhost:8080/v1/models \
  -H 'Authorization: Bearer your-api-key'
```

If using the `API_KEY` environment variable, confirm it is set before starting LocalAI:
```bash
export API_KEY=your-api-key
./local-ai --models-path ./models
```

See `.agents/api-endpoints-and-auth.md` for authentication configuration.

---

## Gallery Model Install Fails

### Symptom
`POST /models/apply` returns an error or the model never appears in `/v1/models`.

### Debugging

1. Check the install job status:
   ```bash
   curl http://localhost:8080/models/jobs/<job-id>
   ```

2. Ensure the gallery URL is reachable from the host machine.

3. Verify disk space is sufficient:
   ```bash
   df -h models/
   ```

See `.agents/adding-gallery-models.md` for gallery model format details.

---

## Build Failures

### Symptom
`make build` fails with compilation errors.

### Common Fixes

- **Missing Go version**: LocalAI requires Go 1.21+.
  ```bash
  go version
  ```
- **Missing C/C++ toolchain**: Install `build-essential` (Debian/Ubuntu) or `base-devel` (Arch).
- **Submodules not initialized**:
  ```bash
  git submodule update --init --recursive
  ```

See `.agents/building-and-testing.md` for the full build guide.

---

## Getting Further Help

- Open an issue on [GitHub](https://github.com/mudler/LocalAI/issues) with logs and your model config (redact any API keys).
- Join the community Discord for real-time support.
- Search existing issues before filing a new one.
