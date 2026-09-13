"""Small OpenAI-compatible JSON client with auditable usage accounting."""
import json
import socket
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from .telemetry import ExecutionLedger


class ModelResponseError(ValueError):
    """A model response needs format correction, not a whole-task retry."""

class JsonChatClient:
    def __init__(
        self, base_url: str, api_key: str, model: str,
        provider: str = "openai-compatible", timeout: int = 60,
        extra_headers: Optional[Dict[str, str]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.provider = provider
        self.timeout = timeout
        self.extra_headers = dict(extra_headers or {})

    @staticmethod
    def _parse_content(content: Any) -> Dict[str, Any]:
        if not isinstance(content, str) or not content.strip():
            raise ModelResponseError("Model content must be a non-empty JSON object")
        content = content.strip()
        # Only remove a complete Markdown fence; never guess missing JSON content.
        lines = content.splitlines()
        if len(lines) >= 3 and lines[0].lower() in {"```json", "```"} and lines[-1] == "```":
            content = "\n".join(lines[1:-1])
        try:
            result = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ModelResponseError(
                "Invalid JSON at line %d column %d" % (exc.lineno, exc.colno)
            ) from exc
        if not isinstance(result, dict):
            raise ModelResponseError("Model JSON root must be an object")
        return result

    def complete_json(
        self, role: str, system: str, user: str,
        ledger: Optional[ExecutionLedger] = None,
        max_tokens: Optional[int] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        payload = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
        }
        if max_tokens is not None:
            payload["max_tokens"] = int(max_tokens)
        headers = {
            "Authorization": "Bearer " + self.api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            **self.extra_headers,
        }

        request = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers, method="POST",
        )
        timeout = self.timeout if timeout_seconds is None else min(self.timeout, timeout_seconds)
        if timeout <= 0:
            raise ValueError("Request timeout must be positive")
        started = time.monotonic()
        usage, error = {}, ""
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
            usage = body.get("usage") or {}
            choice = body["choices"][0]
            finish_reason = choice.get("finish_reason")
            if finish_reason == "length":
                raise ModelResponseError("Model output was truncated; return a shorter complete JSON object")
            if finish_reason not in {None, "stop"}:
                raise RuntimeError("Unexpected model finish_reason: %s" % finish_reason)
            return self._parse_content(choice["message"]["content"])
        except ModelResponseError as exc:
            error = str(exc)
            raise
        except urllib.error.HTTPError as exc:
            error = "%s API returned HTTP %d" % (self.provider, exc.code)
            raise RuntimeError(error) from exc
        except (urllib.error.URLError, socket.timeout, ValueError, KeyError,
                IndexError, TypeError, AttributeError, RuntimeError) as exc:
            error = "%s request/envelope failed: %s" % (self.provider, exc)
            raise RuntimeError(error) from exc
        finally:
            if ledger:
                ledger.record_model(
                    role, self.provider, self.model, usage,
                    int((time.monotonic() - started) * 1000), not error, error,
                )
            
