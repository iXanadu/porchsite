"""One refusal shape for MCP and HTTP (SPEC S8). Port of cloudflare/src/errors.ts."""

from typing import Any


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, extra: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}

    def to_json(self) -> dict[str, Any]:
        return {"error": self.code, "message": self.message, **self.extra}
