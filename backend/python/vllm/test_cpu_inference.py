#!/usr/bin/env python3
"""End-to-end CPU inference smoke test for the vllm backend.

Spawns the gRPC backend server, loads a small Qwen model, runs Predict,
TokenizeString, and Free, and verifies non-empty output.

Usage:
    python test_cpu_inference.py [--model MODEL_ID] [--addr HOST:PORT]

Defaults to Qwen/Qwen2.5-0.5B-Instruct (Qwen3.5-0.6B is not yet published
on the HuggingFace hub at the time of writing).
"""
import argparse
import os
import subprocess
import sys
import time

import grpc

# Make sibling backend_pb2 importable
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import backend_pb2
import backend_pb2_grpc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("TEST_MODEL", "Qwen/Qwen2.5-0.5B-Instruct"))
    parser.add_argument("--addr", default="127.0.0.1:50099")
    parser.add_argument("--prompt", default="Hello, how are you?")
    args = parser.parse_args()

    # Force CPU mode for vLLM
    env = os.environ.copy()
    env.setdefault("VLLM_TARGET_DEVICE", "cpu")
    env.setdefault("VLLM_CPU_KVCACHE_SPACE", "4")

    server_proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "backend.py"), "--addr", args.addr],
        env=env,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )

    try:
        # Wait for the server to come up
        deadline = time.time() + 30
        channel = None
        while time.time() < deadline:
            try:
                channel = grpc.insecure_channel(args.addr)
                grpc.channel_ready_future(channel).result(timeout=2)
                break
            except Exception:
                time.sleep(0.5)
        if channel is None:
            raise RuntimeError("backend server did not start in time")

        stub = backend_pb2_grpc.BackendStub(channel)

        print(f"[test] LoadModel({args.model})", flush=True)
        load_resp = stub.LoadModel(backend_pb2.ModelOptions(
            Model=args.model,
            ContextSize=2048,
        ), timeout=900)
        assert load_resp.success, f"LoadModel failed: {load_resp.message}"

        print(f"[test] Predict prompt={args.prompt!r}", flush=True)
        reply = stub.Predict(backend_pb2.PredictOptions(
            Prompt=args.prompt,
            Tokens=64,
            Temperature=0.7,
            TopP=0.9,
        ), timeout=600)
        text = reply.message.decode("utf-8")
        print(f"[test] Predict output: {text!r}", flush=True)
        assert text.strip(), "Predict returned empty text"

        print("[test] TokenizeString", flush=True)
        tok_resp = stub.TokenizeString(backend_pb2.PredictOptions(Prompt="hello world"), timeout=30)
        print(f"[test] TokenizeString length={tok_resp.length}", flush=True)
        assert tok_resp.length > 0

        print("[test] Free", flush=True)
        free_resp = stub.Free(backend_pb2.MemoryUsageData(), timeout=30)
        assert free_resp.success, f"Free failed: {free_resp.message}"

        print("[test] PASS", flush=True)
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server_proc.kill()


if __name__ == "__main__":
    main()
