#!/usr/bin/env python3
"""
MCP tool test-arg generator worker.
Runs on MacBook Air M3 (192.168.7.225), managed by launchd.

Reads jobs from Redis queue qc:arg_jobs, generates valid test arguments
via local MLX inference (Qwen2.5-7B primary, Llama-3-8B fallback),
validates against the JSON schema, then PATCHes results to toolidx API.
"""

import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import jsonschema
import redis
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REDIS_HOST = "192.168.7.70"
REDIS_PORT = 30059
REDIS_QUEUE = "qc:arg_jobs"

TOOLIDX_API_BASE = "https://toolidx.dev/v1"
TOOLIDX_API_KEY = os.environ.get("TOOLIDX_API_KEY", "")

# Model paths — discovered on M3 at install time.
# Primary: Qwen2.5-7B-Instruct (MLX-quantised, ~4 GB)
# Fallback: Meta-Llama-3-8B-Instruct (MLX-quantised, ~5 GB)
# Only one model is resident in memory at a time.
QWEN_MODEL_PATH = os.environ.get(
    "QWEN_MODEL_PATH",
    str(Path.home() / "mlx-models" / "qwen2.5-7b-4bit"),
)
# Llama-3-8B not present on this M3 — fallback uses naive rules if Qwen fails
LLAMA_MODEL_PATH = os.environ.get(
    "LLAMA_MODEL_PATH",
    str(Path.home() / "mlx-models" / "Meta-Llama-3-8B-Instruct-4bit"),
)

LOG_PATH = Path.home() / "mcp-arg-generator" / "worker.log"

MAX_NEW_TOKENS = 512
INFERENCE_TIMEOUT = 60  # seconds

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("arg-generator")

# ---------------------------------------------------------------------------
# Lazy model state — only one loaded at a time
# ---------------------------------------------------------------------------

_current_model_name: str | None = None
_model = None
_tokenizer = None


def _unload_model() -> None:
    """Release current model from memory."""
    global _model, _tokenizer, _current_model_name
    if _model is not None:
        log.info("Unloading model %s", _current_model_name)
        _model = None
        _tokenizer = None
        _current_model_name = None
        # Give Metal time to reclaim memory before loading next model.
        time.sleep(2)


def _load_model(model_path: str, model_name: str) -> tuple:
    """Load an MLX model, unloading any currently-resident model first."""
    global _model, _tokenizer, _current_model_name

    if _current_model_name == model_name:
        return _model, _tokenizer

    _unload_model()

    log.info("Loading model %s from %s", model_name, model_path)
    try:
        from mlx_lm import load  # type: ignore

        model, tokenizer = load(model_path)
        _model = model
        _tokenizer = tokenizer
        _current_model_name = model_name
        log.info("Model %s loaded", model_name)
        return model, tokenizer
    except Exception as exc:
        log.error("Failed to load model %s: %s", model_name, exc)
        raise


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

PROMPT_TEMPLATE = (
    "You are a JSON test-data generator. "
    "Given the JSON Schema below, return ONLY a single valid JSON object "
    "that satisfies the schema — no explanation, no markdown, no extra text.\n\n"
    "Schema:\n{schema}\n\n"
    "JSON object:"
)


def _run_inference(model, tokenizer, schema_json: str) -> str:
    """Run MLX inference and return the raw model output string."""
    from mlx_lm import generate  # type: ignore

    prompt = PROMPT_TEMPLATE.format(schema=schema_json)

    # Apply chat template if the tokenizer supports it.
    if hasattr(tokenizer, "apply_chat_template"):
        messages = [{"role": "user", "content": prompt}]
        try:
            prompt = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
        except Exception:
            pass  # fall back to raw prompt

    result = generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=MAX_NEW_TOKENS,
        verbose=False,
    )
    return result


def _extract_json(raw: str) -> Any:
    """
    Extract the first valid JSON object from a model output string.
    Models sometimes wrap output in markdown fences.
    """
    # Strip markdown code fences
    text = raw.strip()
    for marker in ("```json", "```"):
        if marker in text:
            text = text.split(marker, 1)[-1]
            text = text.rsplit("```", 1)[0]
            text = text.strip()
            break

    # Find the outermost JSON object
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in model output")
    depth = 0
    for i, ch in enumerate(text[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : i + 1])
    raise ValueError("Unbalanced braces in model output")


# ---------------------------------------------------------------------------
# Naive fallback arg generation
# ---------------------------------------------------------------------------

FORMAT_DEFAULTS = {
    "uri": "https://example.com",
    "email": "test@example.com",
    "uuid": "00000000-0000-0000-0000-000000000000",
    "date-time": "2026-01-01T00:00:00Z",
    "date": "2026-01-01",
    "time": "00:00:00",
}

TYPE_DEFAULTS = {
    "string": "test",
    "integer": 0,
    "number": 0.0,
    "boolean": False,
    "array": [],
    "null": None,
}


def _naive_value(prop_schema: dict) -> Any:
    """Generate a single naive value for one property schema."""
    # enum — pick first value
    if "enum" in prop_schema:
        return prop_schema["enum"][0]

    ptype = prop_schema.get("type", "string")

    if ptype == "string":
        fmt = prop_schema.get("format")
        return FORMAT_DEFAULTS.get(fmt, "test")

    if ptype == "object":
        return naive_args(prop_schema)

    if ptype == "array":
        return []

    return TYPE_DEFAULTS.get(ptype, "test")


def naive_args(schema: dict) -> dict:
    """
    Generate naive fallback args from a JSON Schema object.
    Only required properties are filled; optional ones are omitted.
    """
    result: dict = {}
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))

    for prop_name, prop_schema in properties.items():
        if prop_name in required:
            result[prop_name] = _naive_value(prop_schema)

    # If there are no declared required properties but the schema has
    # properties, include them all so we at least produce something testable.
    if not result and properties:
        for prop_name, prop_schema in properties.items():
            result[prop_name] = _naive_value(prop_schema)

    return result


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def validate_args(args: Any, schema: dict) -> bool:
    try:
        jsonschema.validate(instance=args, schema=schema)
        return True
    except jsonschema.ValidationError:
        return False


# ---------------------------------------------------------------------------
# Toolidx API
# ---------------------------------------------------------------------------


def patch_test_args(schema_hash: str, args: dict, generated_by: str) -> bool:
    if not TOOLIDX_API_KEY:
        log.error("TOOLIDX_API_KEY not set — cannot PATCH results")
        return False

    url = f"{TOOLIDX_API_BASE}/tools/test_args"
    payload = {
        "schema_hash": schema_hash,
        "args": args,
        "generated_by": generated_by,
    }
    headers = {
        "Authorization": f"Bearer {TOOLIDX_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.patch(url, json=payload, headers=headers, timeout=15)
        resp.raise_for_status()
        return True
    except requests.RequestException as exc:
        log.error("PATCH %s failed: %s", url, exc)
        return False


# ---------------------------------------------------------------------------
# Job processing
# ---------------------------------------------------------------------------


def process_job(job_payload: dict) -> None:
    schema_hash: str = job_payload["schema_hash"]
    schema: dict = job_payload["schema"]

    schema_json = json.dumps(schema, separators=(",", ":"))
    log.info("Processing schema_hash=%s", schema_hash)

    generated_by = "naive"
    final_args: dict = {}
    success = False

    # --- Attempt 1: Qwen2.5-7B ---
    try:
        model, tokenizer = _load_model(QWEN_MODEL_PATH, "qwen2.5-7b")
        raw = _run_inference(model, tokenizer, schema_json)
        candidate = _extract_json(raw)
        if validate_args(candidate, schema):
            final_args = candidate
            generated_by = "qwen2.5-7b"
            success = True
            log.info("schema_hash=%s  generated_by=qwen2.5-7b  valid=True", schema_hash)
        else:
            log.warning(
                "schema_hash=%s  qwen2.5-7b output invalid — trying llama fallback",
                schema_hash,
            )
    except Exception as exc:
        log.warning("schema_hash=%s  qwen2.5-7b inference error: %s", schema_hash, exc)

    # --- Attempt 2: Llama-3-8B fallback (lazy) ---
    if not success:
        try:
            model, tokenizer = _load_model(LLAMA_MODEL_PATH, "llama-3-8b")
            raw = _run_inference(model, tokenizer, schema_json)
            candidate = _extract_json(raw)
            if validate_args(candidate, schema):
                final_args = candidate
                generated_by = "llama-3-8b"
                success = True
                log.info(
                    "schema_hash=%s  generated_by=llama-3-8b  valid=True", schema_hash
                )
            else:
                log.warning(
                    "schema_hash=%s  llama-3-8b output also invalid — using naive",
                    schema_hash,
                )
        except Exception as exc:
            log.warning("schema_hash=%s  llama-3-8b inference error: %s", schema_hash, exc)

    # --- Attempt 3: Naive fallback ---
    if not success:
        final_args = naive_args(schema)
        generated_by = "naive"
        log.info(
            "schema_hash=%s  generated_by=naive  (both MLX models failed or invalid)",
            schema_hash,
        )

    # --- PATCH result ---
    patched = patch_test_args(schema_hash, final_args, generated_by)
    status_str = "ok" if patched else "patch_failed"
    log.info(
        "schema_hash=%s  generated_by=%s  patch=%s  ts=%s",
        schema_hash,
        generated_by,
        status_str,
        datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def main() -> None:
    if not TOOLIDX_API_KEY:
        log.error(
            "TOOLIDX_API_KEY env var not set. "
            "Set it before starting the worker. Exiting."
        )
        sys.exit(1)

    log.info("Connecting to Redis %s:%s", REDIS_HOST, REDIS_PORT)
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    try:
        r.ping()
        log.info("Redis PING OK")
    except redis.exceptions.ConnectionError as exc:
        log.error("Cannot reach Redis: %s", exc)
        sys.exit(1)

    log.info("Worker ready. Waiting on queue %s …", REDIS_QUEUE)

    while True:
        try:
            # BLPOP blocks indefinitely (timeout=0) until a job arrives.
            item = r.blpop(REDIS_QUEUE, timeout=0)
            if item is None:
                continue
            _, raw_payload = item
            try:
                job = json.loads(raw_payload)
            except json.JSONDecodeError as exc:
                log.error("Malformed job payload: %s — raw=%s", exc, raw_payload[:200])
                continue

            process_job(job)

        except redis.exceptions.ConnectionError as exc:
            log.error("Redis connection lost: %s — reconnecting in 5s", exc)
            time.sleep(5)
            try:
                r = redis.Redis(
                    host=REDIS_HOST, port=REDIS_PORT, decode_responses=True
                )
            except Exception:
                pass
        except KeyboardInterrupt:
            log.info("Worker interrupted — exiting")
            sys.exit(0)
        except Exception as exc:
            log.exception("Unexpected error in main loop: %s", exc)
            time.sleep(2)


if __name__ == "__main__":
    main()
