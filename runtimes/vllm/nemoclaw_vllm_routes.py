# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Limit bearer vLLM to the inference endpoints NemoClaw routes to and its health probe."""

# Model listing and the request endpoints of the Chat Completions, Completions,
# Responses, and Anthropic Messages APIs; native vLLM authentication requires
# the key for each. GET /health stays public for readiness checks. Every other
# request returns 404 here, including OPTIONS, and management routes that
# owner-set VLLM_* variables register under /v1, such as LoRA adapter loading.
ROUTES = frozenset({
    ("GET", "/health"),
    ("GET", "/v1/models"),
    ("POST", "/v1/chat/completions"),
    ("POST", "/v1/completions"),
    ("POST", "/v1/responses"),
    ("POST", "/v1/messages"),
    ("POST", "/v1/messages/count_tokens"),
})


class OpenAIRoutes:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        # Match native authentication's path handling when a root path is set.
        path = scope.get("path", "").removeprefix(scope.get("root_path", ""))
        if (scope.get("method"), path) in ROUTES:
            return await self.app(scope, receive, send)
        await send({
            "type": "http.response.start",
            "status": 404,
            "headers": [(b"content-type", b"application/json")],
        })
        await send({"type": "http.response.body", "body": b'{"error":"Not found"}'})
