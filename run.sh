#!/usr/bin/env bash
# Launch Brew in development (runs the Electron app from source).
set -e

# Resolve this script's own directory so it works from anywhere.
cd "$(dirname "$0")"

# ELECTRON_RUN_AS_NODE forces Electron to boot as plain Node, which makes
# require('electron') return a path string (undefined ipcMain). Clear it.
unset ELECTRON_RUN_AS_NODE

# Install deps on first run if needed.
if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install
fi

exec ./node_modules/.bin/electron .
