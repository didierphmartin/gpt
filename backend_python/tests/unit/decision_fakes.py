"""Shared fakes for the decision-routing tests: Guzzle's MockHandler + history middleware as an
httpx.MockTransport, and ApiKeyCrypto::encrypt for user_api_keys rows. No network."""
from __future__ import annotations

import base64
import hashlib
import json
import os

import httpx

from app.support.crypto import aes256cbc_encrypt


class ConnectFailure:
    """A queued transport failure (Guzzle ConnectException)."""

    def __init__(self, message: str = 'timeout'):
        self.message = message


def mock_client(queue: list, history: list | None = None) -> httpx.Client:
    """An httpx.Client answering queued httpx.Response / ConnectFailure items in order; every request
    lands in history. An exhausted queue is a test error, like Guzzle's MockHandler."""
    queue = list(queue)

    def handler(request: httpx.Request) -> httpx.Response:
        if history is not None:
            history.append(request)
        if not queue:
            raise AssertionError('mock queue is empty')
        item = queue.pop(0)
        if isinstance(item, ConnectFailure):
            raise httpx.ConnectError(item.message, request=request)
        return item

    return httpx.Client(transport=httpx.MockTransport(handler))


def json_response(status: int, body) -> httpx.Response:
    return httpx.Response(status, text=body if isinstance(body, str) else json.dumps(body))


def encrypt_key(apiKey: str, secret: str) -> str:
    """ApiKeyCrypto::encrypt: base64(iv16 . AES-256-CBC(plaintext)), key = sha256(secret)."""
    key = hashlib.sha256(secret.encode()).digest()
    iv = os.urandom(16)
    return base64.b64encode(iv + aes256cbc_encrypt(apiKey.encode('utf-8'), key, iv)).decode('ascii')
