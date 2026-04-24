# MLX Arg-Generator Worker

Runs on the MacBook Air M3 (192.168.7.225) as a launchd-managed Python process.

Reads tool schema jobs from a Redis queue, generates valid test arguments via
local MLX inference (Qwen2.5-7B → Llama-3-8B → naive fallback), and PATCHes
results to the toolidx API.

---

## Architecture

```
toolidx API / QC pipeline
        │
        │  RPUSH qc:arg_jobs {"schema_hash":"…","schema":{…}}
        ▼
  Redis 192.168.7.70:30059
        │
        │  BLPOP (blocking)
        ▼
  worker.py  (M3 MBA, launchd)
        │
        ├─► Qwen2.5-7B-Instruct (MLX)  — primary
        ├─► Meta-Llama-3-8B-Instruct (MLX)  — fallback (lazy-loaded)
        └─► naive rules  — last resort
        │
        │  PATCH /v1/tools/test_args
        ▼
  toolidx API  →  D1 tool_test_args table
```

### Memory discipline
- Only one model is resident in memory at a time.
- Llama-3-8B is loaded **only** when Qwen2.5-7B produces an invalid result.
- When the fallback model is loaded, the primary is explicitly released first.
- Other Sanity Panel agents share the M3's 16 GB unified memory; this worker
  targets < 6 GB peak (4-bit quantised 7-8B models).

---

## Files

| File | Purpose |
|---|---|
| `worker.py` | Main worker loop |
| `com.toolidx.arg-generator.plist` | launchd agent definition |
| `install.sh` | One-command deploy from any SSH-capable host |
| `README.md` | This file |

---

## Prerequisites on the M3

- macOS 13 + Apple Silicon
- Python ≥ 3.10 (ships with Xcode CLT; `xcode-select --install`)
- `mlx-lm` installable via pip (requires macOS + Apple Silicon)
- Redis reachable at 192.168.7.70:30059

### MLX model paths (defaults)

The worker looks for models at these paths by default.
Override via environment variables in the plist if your layout differs.

| Model | Default path | Env override |
|---|---|---|
| Qwen2.5-7B-Instruct | `~/models/mlx-community/Qwen2.5-7B-Instruct-4bit` | `QWEN_MODEL_PATH` |
| Meta-Llama-3-8B-Instruct | `~/models/mlx-community/Meta-Llama-3-8B-Instruct-4bit` | `LLAMA_MODEL_PATH` |

Download with mlx-lm if not already present:
```bash
python -m mlx_lm.convert --hf-path Qwen/Qwen2.5-7B-Instruct \
  --mlx-path ~/models/mlx-community/Qwen2.5-7B-Instruct-4bit -q
python -m mlx_lm.convert --hf-path meta-llama/Meta-Llama-3-8B-Instruct \
  --mlx-path ~/models/mlx-community/Meta-Llama-3-8B-Instruct-4bit -q
```

Or download pre-quantised from Hugging Face:
```bash
pip install huggingface_hub
huggingface-cli download mlx-community/Qwen2.5-7B-Instruct-4bit \
  --local-dir ~/models/mlx-community/Qwen2.5-7B-Instruct-4bit
huggingface-cli download mlx-community/Meta-Llama-3-8B-Instruct-4bit \
  --local-dir ~/models/mlx-community/Meta-Llama-3-8B-Instruct-4bit
```

---

## Install

Run from any machine with SSH access to the M3:

```bash
bash arg-generator/install.sh
```

This will:
1. Create `~/mcp-arg-generator/` on the M3
2. Copy `worker.py` there and set up a Python venv with all deps
3. Print discovered MLX model paths
4. Copy the plist to `~/Library/LaunchAgents/`
5. Bootstrap the launchd agent (starts immediately, restarts on crash)

To target a different host:
```bash
TARGET_HOST=gregory@192.168.7.225 bash arg-generator/install.sh
```

---

## Start / stop / restart

```bash
# SSH to the M3 first
ssh gregory@192.168.7.225

# Stop
launchctl bootout gui/$(id -u)/com.toolidx.arg-generator

# Start
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.toolidx.arg-generator.plist

# Restart (stop then start)
launchctl kickstart -k gui/$(id -u)/com.toolidx.arg-generator

# Status
launchctl print gui/$(id -u)/com.toolidx.arg-generator
```

---

## Logs

```bash
# Tail live
ssh gregory@192.168.7.225 'tail -f ~/mcp-arg-generator/worker.log'

# Last 100 lines
ssh gregory@192.168.7.225 'tail -100 ~/mcp-arg-generator/worker.log'
```

Log format:
```
2026-04-23T14:00:00+00:00  INFO     Processing schema_hash=abc123
2026-04-23T14:00:05+00:00  INFO     schema_hash=abc123  generated_by=qwen2.5-7b  valid=True
2026-04-23T14:00:05+00:00  INFO     schema_hash=abc123  generated_by=qwen2.5-7b  patch=ok  ts=2026-04-23T14:00:05Z
```

---

## Update

```bash
# Re-run install.sh — it's fully idempotent
bash arg-generator/install.sh

# Or manually copy worker.py and restart
scp arg-generator/worker.py gregory@192.168.7.225:~/mcp-arg-generator/worker.py
ssh gregory@192.168.7.225 \
  'launchctl kickstart -k gui/$(id -u)/com.toolidx.arg-generator'
```

---

## Enqueue a test job (development)

```bash
redis-cli -h 192.168.7.70 -p 30059 RPUSH qc:arg_jobs \
  '{"schema_hash":"test001","schema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]}}'
```

Then watch the log:
```bash
ssh gregory@192.168.7.225 'tail -f ~/mcp-arg-generator/worker.log'
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TOOLIDX_API_KEY` | set in plist | Bearer token for toolidx API |
| `QWEN_MODEL_PATH` | `~/models/mlx-community/Qwen2.5-7B-Instruct-4bit` | Path to primary MLX model |
| `LLAMA_MODEL_PATH` | `~/models/mlx-community/Meta-Llama-3-8B-Instruct-4bit` | Path to fallback MLX model |
