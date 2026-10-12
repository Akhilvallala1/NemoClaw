# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Limit bearer vLLM to its native-authenticated OpenAI API and health probe."""


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
        if path == "/v1" or path.startswith("/v1/") or (
            path == "/health" and scope.get("method") in ("GET", "HEAD")
        ):
            return await self.app(scope, receive, send)
        await send({
            "type": "http.response.start",
            "status": 404,
            "headers": [(b"content-type", b"application/json")],
        })
        await send({"type": "http.response.body", "body": b'{"error":"Not found"}'})
