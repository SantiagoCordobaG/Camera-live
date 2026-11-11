#!/usr/bin/env bash
# Servidor local para FRAME FX (la cámara requiere localhost o HTTPS).
cd "$(dirname "$0")" || exit 1
PORT="${1:-8123}"
echo "FRAME FX → http://localhost:$PORT"
python3 -m http.server "$PORT"
