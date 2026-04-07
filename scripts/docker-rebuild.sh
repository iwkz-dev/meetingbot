#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.yml"
IMAGE_NAME="meetingbot:local"
CONTAINER_NAME="meetingbot"
PORT_VALUE="${PORT:-3010}"

echo "[docker-rebuild] Project root: $PROJECT_ROOT"
echo "[docker-rebuild] Publishing port: $PORT_VALUE"

if ! docker version >/dev/null 2>&1; then
    echo "[docker-rebuild] Docker is not available. Start Docker first." >&2
    exit 1
fi

echo "[docker-rebuild] Stopping and removing existing compose resources if they exist..."
PORT="$PORT_VALUE" docker compose -f "$COMPOSE_FILE" down --remove-orphans

EXISTING_CONTAINER_ID=$(docker ps -aq --filter "name=^${CONTAINER_NAME}$")
if [ -n "$EXISTING_CONTAINER_ID" ]; then
    echo "[docker-rebuild] Removing leftover container '$CONTAINER_NAME'..."
    docker rm -f "$CONTAINER_NAME"
fi

EXISTING_IMAGE_ID=$(docker image ls -q "$IMAGE_NAME")
if [ -n "$EXISTING_IMAGE_ID" ]; then
    echo "[docker-rebuild] Removing existing image '$IMAGE_NAME'..."
    docker image rm -f "$IMAGE_NAME"
fi

echo "[docker-rebuild] Building fresh image..."
PORT="$PORT_VALUE" docker compose -f "$COMPOSE_FILE" build --no-cache

echo "[docker-rebuild] Starting container..."
PORT="$PORT_VALUE" docker compose -f "$COMPOSE_FILE" up -d

echo "[docker-rebuild] Current status:"
PORT="$PORT_VALUE" docker compose -f "$COMPOSE_FILE" ps
