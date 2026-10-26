"""Minimal OpenAI HTTP client (stdlib only). The key is read from the live
plugin config (never printed, never written to results)."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

OPENCLAW_CONFIG = Path("~/.openclaw/openclaw.json").expanduser()
LIVE_ENTRY = "voice-call-tristan"


class ApiError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


def read_key() -> Optional[str]:
    try:
        c = json.loads(OPENCLAW_CONFIG.read_text())
        k = c["plugins"]["entries"][LIVE_ENTRY]["config"]["streaming"]["openaiApiKey"]
        if k:
            return k
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return os.environ.get("OPENAI_API_KEY") or None


def _request(req: urllib.request.Request, timeout: float, retries: int = 2) -> dict:
    last: Exception = RuntimeError("no attempt")
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec B310 - fixed https://api.openai.com URLs
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            last = ApiError(e.code, body)
            if e.code < 500 and e.code != 429:
                raise last
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise last


def post_json(path: str, payload: dict, key: str, timeout: float = 120) -> dict:
    req = urllib.request.Request(
        f"https://api.openai.com/v1/{path}", data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    return _request(req, timeout)


def post_multipart(path: str, fields: list, file_field: str, filename: str, file_bytes: bytes, key: str,
                   content_type: str = "audio/wav", timeout: float = 180) -> dict:
    """fields: [(name, value)] (repeat a name for array fields)."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields:
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\n"
                 f"Content-Type: {content_type}\r\n\r\n".encode())
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"https://api.openai.com/v1/{path}", data=b"".join(parts), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    return _request(req, timeout)
