#!/usr/bin/env bash
# AIDO setup script — installs system dependencies and creates workspace directory.
# Run once on a fresh Linux/macOS VM before starting AIDO.

set -euo pipefail

echo "=== AIDO Setup ==="

# Detect platform
PLATFORM="$(uname -s)"

if [[ "$PLATFORM" == "Linux" ]]; then
  echo "Detected Linux. Installing dependencies via apt-get..."
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends tmux ripgrep git build-essential python3
  echo "Linux dependencies installed."

elif [[ "$PLATFORM" == "Darwin" ]]; then
  echo "Detected macOS. Installing dependencies via Homebrew..."
  if ! command -v brew &>/dev/null; then
    echo "Homebrew not found. Please install it from https://brew.sh first."
    exit 1
  fi
  brew install tmux ripgrep git
  echo "macOS dependencies installed."

else
  echo "Windows detected (or unknown platform: $PLATFORM)."
  echo "On Windows:"
  echo "  - tmux is not available; AIDO will use node-pty (ConPTY) instead."
  echo "  - Install ripgrep: https://github.com/BurntSushi/ripgrep/releases"
  echo "  - Install git: https://git-scm.com/download/win"
  echo "  - Install Visual Studio Build Tools for node-pty native compilation."
fi

# Create workspace directory
WORKSPACE_DIR="${WORKSPACE_ROOT:-/workspace}"
if [[ "$PLATFORM" != "Linux" && "$PLATFORM" != "Darwin" ]]; then
  WORKSPACE_DIR="${WORKSPACE_ROOT:-C:/workspace}"
fi

echo "Creating workspace directory at $WORKSPACE_DIR..."
mkdir -p "$WORKSPACE_DIR"
echo "Workspace created."

echo ""
echo "=== Setup complete! ==="
echo "Run: npm install && npm run build && npm start"
