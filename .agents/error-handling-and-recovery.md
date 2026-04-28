# Error Handling and Recovery in LocalAI

This guide covers patterns for robust error handling, graceful degradation, and recovery strategies used throughout LocalAI.

## Core Error Types

LocalAI defines structured error types to distinguish between recoverable and fatal conditions:

```go
// pkg/errors/errors.go

package errors

import (
	"errors"
	"fmt"
)

// ModelLoadError indicates a failure during model initialization
type ModelLoadError struct {
	ModelName string
	Cause     error
}

func (e *ModelLoadError) Error() string {
	return fmt.Sprintf("failed to load model %q: %v", e.ModelName, e.Cause)
}

func (e *ModelLoadError) Unwrap() error { return e.Cause }

// BackendUnavailableError indicates a backend process is not reachable
type BackendUnavailableError struct {
	Backend string
	Cause   error
}

func (e *BackendUnavailableError) Error() string {
	return fmt.Sprintf("backend %q unavailable: %v", e.Backend, e.Cause)
}

func (e *BackendUnavailableError) Unwrap() error { return e.Cause }

// IsModelLoadError checks if an error is or wraps a ModelLoadError
func IsModelLoadError(err error) bool {
	var target *ModelLoadError
	return errors.As(err, &target)
}

// IsBackendUnavailable checks if an error is or wraps a BackendUnavailableError
func IsBackendUnavailable(err error) bool {
	var target *BackendUnavailableError
	return errors.As(err, &target)
}
```

## HTTP Error Responses

All API handlers should return structured JSON errors consistent with the OpenAI API format:

```go
type APIError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Type    string `json:"type"`
}

type ErrorResponse struct {
	Error *APIError `json:"error"`
}

func sendError(c *fiber.Ctx, status int, errType, message string) error {
	return c.Status(status).JSON(ErrorResponse{
		Error: &APIError{
			Code:    status,
			Message: message,
			Type:    errType,
		},
	})
}
```

Common usage in handlers:

```go
func MyHandler(cl *config.BackendConfigLoader, ml *model.ModelLoader, appConfig *config.ApplicationConfig) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Parse request
		var req MyRequest
		if err := c.BodyParser(&req); err != nil {
			return sendError(c, fiber.StatusBadRequest, "invalid_request", err.Error())
		}

		// Attempt model operation
		result, err := doModelOperation(cl, ml, req)
		if err != nil {
			switch {
			case localerrors.IsModelLoadError(err):
				return sendError(c, fiber.StatusUnprocessableEntity, "model_error", err.Error())
			case localerrors.IsBackendUnavailable(err):
				return sendError(c, fiber.StatusServiceUnavailable, "backend_error", err.Error())
			default:
				return sendError(c, fiber.StatusInternalServerError, "internal_error", err.Error())
			}
		}

		return c.JSON(result)
	}
}
```

## Backend Recovery

Backend gRPC processes can crash. LocalAI uses a watchdog pattern to detect and restart them:

```go
// Watchdog checks backend health and restarts if needed
func (ml *ModelLoader) WatchBackend(ctx context.Context, modelName string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := ml.CheckBackendHealth(modelName); err != nil {
				log.Warn().Str("model", modelName).Err(err).Msg("backend unhealthy, reloading")
				if reloadErr := ml.ReloadBackend(modelName); reloadErr != nil {
					log.Error().Str("model", modelName).Err(reloadErr).Msg("failed to reload backend")
				}
			}
		}
	}
}
```

## Retry Logic

For transient failures (e.g., backend briefly busy), use exponential backoff:

```go
import "github.com/avast/retry-go"

func callWithRetry(fn func() error) error {
	return retry.Do(
		fn,
		retry.Attempts(3),
		retry.Delay(200*time.Millisecond),
		retry.DelayType(retry.BackOffDelay),
		retry.RetryIf(func(err error) bool {
			// Only retry on backend unavailable, not on model/config errors
			return localerrors.IsBackendUnavailable(err)
		}),
		retry.OnRetry(func(n uint, err error) {
			log.Warn().Uint("attempt", n+1).Err(err).Msg("retrying backend call")
		}),
	)
}
```

## Context Cancellation

All long-running operations should respect context cancellation to avoid goroutine leaks:

```go
func streamResponse(ctx context.Context, ch <-chan string, c *fiber.Ctx) error {
	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")

	for {
		select {
		case <-ctx.Done():
			log.Debug().Msg("client disconnected, stopping stream")
			return nil
		case token, ok := <-ch:
			if !ok {
				return nil // stream complete
			}
			fmt.Fprintf(c, "data: %s\n\n", token)
		}
	}
}
```

## Panic Recovery Middleware

A Fiber middleware recovers from unexpected panics and logs them with a stack trace:

```go
func PanicRecoveryMiddleware() fiber.Handler {
	return recover.New(recover.Config{
		EnableStackTrace: true,
		StackTraceHandler: func(c *fiber.Ctx, e interface{}) {
			log.Error().
				Str("path", c.Path()).
				Interface("panic", e).
				Msg("recovered from panic")
		},
	})
}
```

Register it early in the middleware chain in `app.go`:

```go
app.Use(PanicRecoveryMiddleware())
```

## Logging Conventions

- Use `log.Error()` for unrecoverable failures that affect the response.
- Use `log.Warn()` for recoverable issues (retry, fallback used).
- Use `log.Debug()` for expected non-error paths (e.g., cache miss).
- Always attach context fields: model name, request ID, backend name.

```go
log.Error().
	Str("model", modelName).
	Str("request_id", requestID).
	Err(err).
	Msg("inference failed")
```

## Testing Error Paths

Unit tests should cover both happy-path and error-path scenarios:

```go
func TestHandlerReturns503OnBackendUnavailable(t *testing.T) {
	app := fiber.New()
	app.Get("/test", func(c *fiber.Ctx) error {
		return sendError(c, fiber.StatusServiceUnavailable, "backend_error", "backend is down")
	})

	req := httptest.NewRequest("GET", "/test", nil)
	resp, _ := app.Test(req)
	assert.Equal(t, 503, resp.StatusCode)

	var body ErrorResponse
	json.NewDecoder(resp.Body).Decode(&body)
	assert.Equal(t, "backend_error", body.Error.Type)
}
```
