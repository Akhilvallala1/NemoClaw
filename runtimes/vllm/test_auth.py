# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""GPU-free bearer-route checks run in each vLLM runtime image build."""
import asyncio
import os
import re
import secrets
import unittest
from unittest import mock

# Image builds run without GPU access, and these route tests start no engine, so select
# vLLM's CPU platform before vLLM resolves its platform during argument parsing.
os.environ["VLLM_TARGET_DEVICE"] = "cpu"

from vllm import envs
from vllm.entrypoints.serve.utils.server_utils import AuthenticationMiddleware
from nemoclaw_vllm_routes import OpenAIRoutes
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
import model_hosting_container_standards.sagemaker as sagemaker

NOT_FOUND = (404, {"error": "Not found"})
# Requests the filter passes to vLLM: model listing and the request endpoints of
# the inference APIs NemoClaw routes to, all behind the key, plus public GET /health.
INFERENCE = [
    ("GET", "/v1/models"),
    ("POST", "/v1/chat/completions"),
    ("POST", "/v1/completions"),
    ("POST", "/v1/responses"),
    ("POST", "/v1/messages"),
    ("POST", "/v1/messages/count_tokens"),
]
HEALTH = ("GET", "/health")
# Requests vLLM may answer that no NemoClaw route uses, beyond its registered routes.
UNROUTED = [
    ("OPTIONS", "/v1/models"),
    ("OPTIONS", "/v1/does-not-exist"),
    ("OPTIONS", "/invocations"),
    ("HEAD", "/health"),
    ("POST", "/health"),
    ("GET", "/health/"),
    ("GET", "/v1"),
    ("GET", "/v1/"),
    ("GET", "/v1/models/"),
    ("POST", "/v1/models"),
    ("GET", "/v1/chat/completions"),
    ("GET", "/v1/props"),
    ("POST", "/v1/embeddings"),
    ("POST", "/v1other"),
    ("POST", "/v2/chat"),
]
PREFLIGHT = {"Origin": "https://example.invalid", "Access-Control-Request-Method": "POST"}


def build_vllm_app():
    """Build vLLM's own application with the arguments the runtime passes in bearer mode."""
    from vllm.entrypoints.openai import api_server
    from vllm.entrypoints.openai.cli_args import make_arg_parser
    from vllm.utils.argparse_utils import FlexibleArgumentParser

    args = make_arg_parser(FlexibleArgumentParser()).parse_args([
        "--model", "/nonexistent", "--served-model-name", "fixture", "--host", "0.0.0.0",
        "--tensor-parallel-size", "1", "--load-format", "safetensors",
        "--middleware", "nemoclaw_vllm_routes.OpenAIRoutes", "--port", "18888",
    ])
    return api_server.build_app(args, supported_tasks=("generate",), model_config=None)


def registered_requests(app):
    """Each method and concrete path vLLM routes, with path parameters filled in."""
    for route in app.routes:
        path = re.sub(r"\{[^}]*\}", "fixture", route.path)
        for method in sorted(getattr(route, "methods", None) or {"GET"}):
            yield method, path


class RealApplicationTest(unittest.TestCase):
    """Checks vLLM's real build_app, so an upstream middleware or route change cannot bypass the filter."""

    def setUp(self):
        self.key = secrets.token_hex(32)
        # Owner-set recipe variables can register management routes, including
        # LoRA adapter loading under /v1; the filter must hide them from key holders.
        environment = mock.patch.dict(os.environ, {
            "VLLM_API_KEY": self.key,
            "VLLM_ALLOW_RUNTIME_LORA_UPDATING": "1",
            "VLLM_SERVER_DEV_MODE": "1",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def request(self, client, method, path, token=None, headers=None):
        headers = dict(headers or {})
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        response = client.request(method, path, headers=headers, json={})
        if response.headers.get("content-type") == "application/json" and response.content:
            return response.status_code, response.json()
        return response.status_code, None

    def test_route_filter_is_the_outermost_user_middleware(self):
        app = build_vllm_app()
        self.assertIs(app.user_middleware[0].cls, OpenAIRoutes)

    def test_requests_outside_the_inference_endpoints_return_not_found_with_any_key(self):
        app = build_vllm_app()
        client = TestClient(app, raise_server_exceptions=False, follow_redirects=False)
        registered = set(registered_requests(app))
        for request in [("POST", "/invocations"), ("POST", "/tokenize"), ("GET", "/metrics"),
                        ("GET", "/ping"), ("GET", "/version"), ("GET", "/load"),
                        ("POST", "/inference/v1/generate"), ("GET", "/openapi.json"),
                        ("POST", "/v1/load_lora_adapter"), ("POST", "/v1/unload_lora_adapter"),
                        ("POST", "/v1/responses/fixture/cancel"), ("POST", "/sleep")]:
            self.assertIn(request, registered)
        for method, path in sorted(registered - set(INFERENCE) - {HEALTH}) + UNROUTED:
            for token in [None, "wrong", self.key]:
                for headers in [None, PREFLIGHT] if method == "OPTIONS" else [None]:
                    with self.subTest(method=method, path=path, token=token is not None,
                                      preflight=headers is not None):
                        status, body = self.request(client, method, path, token, headers)
                        self.assertEqual(status, 404)
                        if method != "HEAD":
                            self.assertEqual((status, body), NOT_FOUND)

    def test_inference_endpoints_require_the_key_and_health_stays_public(self):
        client = TestClient(build_vllm_app(), raise_server_exceptions=False)
        for method, path in INFERENCE:
            for token in [None, "wrong"]:
                with self.subTest(method=method, path=path, token=token):
                    self.assertEqual(self.request(client, method, path, token)[0], 401)
            with self.subTest(method=method, path=path, token="key"):
                result = self.request(client, method, path, self.key)
                self.assertNotEqual(result, NOT_FOUND)
                self.assertNotEqual(result[0], 401)
        # Without an engine the handler fails, but the request reaches vLLM without a key.
        self.assertNotIn(self.request(client, *HEALTH)[0], [401, 404])


class NativeAuthenticationTest(unittest.TestCase):
    def test_sagemaker_bootstrap_cannot_bypass_the_inference_boundary(self):
        key = secrets.token_hex(32)
        invoked = []
        app = FastAPI()

        @app.post("/v1/chat/completions")
        @app.post("/invocations")
        @sagemaker.register_invocation_handler
        async def completion(request: Request):
            invoked.append(request.url.path)
            return {"choices": [{"message": {"content": "fixture completion"}}]}

        @app.get("/health")
        async def health():
            return {}

        # This is vLLM's build_app order, including the final SageMaker bootstrap.
        app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
        app.add_middleware(AuthenticationMiddleware, tokens=[key])
        app.add_middleware(OpenAIRoutes)
        app = sagemaker.bootstrap(app)
        with TestClient(app) as client:
            for token in [None, "wrong", key]:
                headers = {} if token is None else {"Authorization": f"Bearer {token}"}
                self.assertEqual(client.post("/invocations", headers=headers, json={}).status_code, 404)
                expected = 200 if token == key else 401
                self.assertEqual(client.post("/v1/chat/completions", headers=headers, json={}).status_code, expected)
            self.assertEqual(invoked, ["/v1/chat/completions"])
            self.assertEqual(client.get("/health").status_code, 200)
            # NemoClaw has no browser clients, so CORS preflight stops at the filter.
            self.assertEqual(client.options("/v1/chat/completions", headers=PREFLIGHT).status_code, 404)
            self.assertEqual(invoked, ["/v1/chat/completions"])

    def test_unsupported_websockets_are_closed_before_the_application(self):
        async def application(scope, receive, send):
            await send({"type": "websocket.accept"})

        async def request(path):
            messages = []

            async def receive():
                return {"type": "websocket.connect"}

            async def send(message):
                messages.append(message)

            await OpenAIRoutes(application)({"type": "websocket", "path": path}, receive, send)
            return messages

        for path in ["/v1/chat/completions", "/invocations", "/health"]:
            self.assertEqual(asyncio.run(request(path)), [{"type": "websocket.close", "code": 1008}])

    def test_environment_key_guards_inference_paths(self):
        key = secrets.token_hex(32)
        previous = os.environ.get("VLLM_API_KEY")
        os.environ["VLLM_API_KEY"] = key
        try:
            self.assertEqual(envs.VLLM_API_KEY, key)

            async def application(scope, receive, send):
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b""})

            middleware = OpenAIRoutes(AuthenticationMiddleware(application, [envs.VLLM_API_KEY]))

            async def request(path, token, method="POST", root_path="", app=middleware):
                statuses = []

                async def send(message):
                    if message["type"] == "http.response.start":
                        statuses.append(message["status"])

                async def receive():
                    return {"type": "http.request", "body": b"", "more_body": False}

                headers = [] if token is None else [(b"authorization", f"Bearer {token}".encode())]
                await app({"type": "http", "method": method, "path": root_path + path,
                           "root_path": root_path, "headers": headers}, receive, send)
                return statuses

            for root_path in ["", "/inference"]:
                for method, path in INFERENCE:
                    with self.subTest(path=path, method=method, root_path=root_path):
                        self.assertEqual(asyncio.run(request(path, None, method, root_path)), [401])
                        self.assertEqual(asyncio.run(request(path, "wrong", method, root_path)), [401])
                        self.assertEqual(asyncio.run(request(path, key, method, root_path)), [200])
                self.assertEqual(asyncio.run(request("/health", None, "GET", root_path)), [200])
                for method, path in UNROUTED + [
                    ("POST", "/invocations"), ("POST", "/inference"), ("POST", "/tokenize"),
                    ("GET", "/metrics"), ("PUT", "/health"), ("DELETE", "/health"),
                    ("POST", "/v1/load_lora_adapter"), ("POST", "/v1/unload_lora_adapter"),
                    ("GET", "/v1/responses/fixture"), ("POST", "/v1/responses/fixture/cancel"),
                    ("POST", "/v1/chat/completions/render"), ("POST", "/v1/completions/derender"),
                ]:
                    for token in [None, "wrong", key]:
                        with self.subTest(path=path, method=method, root_path=root_path):
                            self.assertEqual(asyncio.run(request(path, token, method, root_path)), [404])
            # Without the bearer-only middleware the upstream route set is unchanged.
            self.assertEqual(asyncio.run(request("/invocations", None, app=application)), [200])
        finally:
            if previous is None:
                os.environ.pop("VLLM_API_KEY", None)
            else:
                os.environ["VLLM_API_KEY"] = previous


if __name__ == "__main__":
    unittest.main()
