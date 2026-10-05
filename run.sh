#!/usr/bin/env bash
# Cheat Clip PRO — launcher dev
# Menetralkan env lokal yang mengganggu (npm 12 allow-scripts & NODE_ENV=production)
set -e
cd "$(dirname "$0")"

# Env dari shell user yang merusak install/dev mode
unset npm_config_allow_scripts 2>/dev/null || true
export NODE_ENV=development

# Sanity check dependensi
if [ ! -d node_modules ]; then
  echo "[!] node_modules belum ada. Jalankan:"
  echo "    env -u npm_config_allow_scripts npm install"
  exit 1
fi

if [ ! -x venv/bin/python ]; then
  echo "[!] Virtualenv belum ada. Jalankan:"
  echo "    python3 -m venv venv"
  echo "    venv/bin/pip install -r backend/requirements.txt"
  exit 1
fi

exec npm run dev
