#!/bin/bash
# Ensure End of Line is unix-style (LF)

set -u

export DISPLAY=:99

echo "[entrypoint] Setting up XDG_RUNTIME_DIR..."
export XDG_RUNTIME_DIR=/tmp/runtime-$USER
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Xvfb started as non-root still needs the socket directory to exist.
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

echo "[entrypoint] Starting virtual display..."
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &

if command -v fluxbox >/dev/null 2>&1; then
  echo "[entrypoint] Starting window manager..."
  fluxbox >/tmp/fluxbox.log 2>&1 &
else
  echo "[entrypoint] fluxbox not found, continuing without a window manager..."
fi

echo "[entrypoint] Starting PulseAudio..."
pulseaudio -D --exit-idle-time=-1

# Give a few seconds for everything to warm up
sleep 2

echo "[entrypoint] Starting bot..."
pnpm start
