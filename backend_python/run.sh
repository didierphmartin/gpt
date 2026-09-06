#!/usr/bin/env bash
# Start the Python backend on port 3002 (PHP: Apache /gpt/backend, Node: 3001).
cd "$(dirname "$0")"
source .venv/bin/activate
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-3002}" --reload
