"""Boundary enforcement: validates inbound frames against the JSON Schemas
emitted by packages/contracts. Schemas are COPIED into this package at
contracts build time (mcp_wrapper/schemas/) so the engine stays self-contained
when deployed to a separate GPU box — never path-walk up to the monorepo."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator

SCHEMA_DIR = Path(__file__).parent / "schemas"

def _load(name: str) -> Draft202012Validator:
    path = SCHEMA_DIR / f"{name}.json"
    if not path.exists():
        raise RuntimeError(
            f"Missing contract schema {path}. "
            "Run `pnpm --filter @torqclaw/contracts build` first."
        )
    with open(path) as f:
        return Draft202012Validator(json.load(f))

# Load + compile ONCE at import — never per-request on the hot path.
_GATEWAY_REQUEST = _load("GatewayRequest")

def validate_gateway_request(payload: dict) -> None:
    """Raises jsonschema.ValidationError on schema drift. Raising (not
    returning an error string) lets MCP mark the tool result isError=True."""
    _GATEWAY_REQUEST.validate(payload)
