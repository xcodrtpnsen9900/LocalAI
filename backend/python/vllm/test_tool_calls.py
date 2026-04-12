#!/usr/bin/env python3
"""End-to-end CPU tool-calling test for the vllm backend.

Loads Qwen2.5-0.5B-Instruct with the hermes tool parser, sends a chat
completion with a `get_weather` tool, and checks that the reply's
ChatDelta contains a ToolCallDelta for that function.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import grpc

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import backend_pb2
import backend_pb2_grpc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--addr", default="127.0.0.1:50098")
    args = parser.parse_args()

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

        print(f"[test] LoadModel({args.model}) with hermes tool_parser", flush=True)
        load_resp = stub.LoadModel(backend_pb2.ModelOptions(
            Model=args.model,
            ContextSize=2048,
            Options=["tool_parser:hermes"],
        ), timeout=900)
        assert load_resp.success, f"LoadModel failed: {load_resp.message}"

        tools = [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather for a location",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {
                            "type": "string",
                            "description": "The city and state, e.g. San Francisco, CA",
                        },
                    },
                    "required": ["location"],
                },
            },
        }]

        messages = [
            backend_pb2.Message(role="system", content="You are a helpful assistant. Use the get_weather tool when the user asks about weather."),
            backend_pb2.Message(role="user", content="What's the weather like in Paris, France?"),
        ]

        print("[test] Predict with tool definitions", flush=True)
        reply = stub.Predict(backend_pb2.PredictOptions(
            Messages=messages,
            Tools=json.dumps(tools),
            ToolChoice="auto",
            UseTokenizerTemplate=True,
            Tokens=200,
            Temperature=0.1,
        ), timeout=600)

        text = reply.message.decode("utf-8")
        print(f"[test] Raw message: {text!r}", flush=True)
        print(f"[test] prompt_tokens={reply.prompt_tokens} tokens={reply.tokens}", flush=True)
        print(f"[test] chat_deltas count: {len(reply.chat_deltas)}", flush=True)

        tool_calls_seen = []
        for delta in reply.chat_deltas:
            print(f"[test] delta.content={delta.content!r}", flush=True)
            print(f"[test] delta.reasoning_content={delta.reasoning_content!r}", flush=True)
            for tc in delta.tool_calls:
                print(f"[test] tool_call idx={tc.index} id={tc.id!r} name={tc.name!r} args={tc.arguments!r}", flush=True)
                tool_calls_seen.append(tc)

        # Verify at least one tool call was extracted
        assert len(tool_calls_seen) > 0, (
            "No tool calls in ChatDelta. "
            f"Raw text was: {text!r}"
        )
        assert any(tc.name == "get_weather" for tc in tool_calls_seen), (
            f"Expected get_weather tool call, got: {[tc.name for tc in tool_calls_seen]}"
        )

        print("[test] Free", flush=True)
        stub.Free(backend_pb2.HealthMessage(), timeout=30)

        print("[test] PASS", flush=True)
        return 0

    finally:
        try:
            server_proc.terminate()
            server_proc.wait(timeout=10)
        except Exception:
            server_proc.kill()


if __name__ == "__main__":
    sys.exit(main())
