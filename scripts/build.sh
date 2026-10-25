#!/usr/bin/env bash
# Build and push both arm64 images with exact version tags.
set -euo pipefail
cd "$(dirname "$0")/.."

CAMOUFOX_TAG="${CAMOUFOX_TAG:-156.0.1-2}"
GATEWAY_TAG="$(jq -r .version package.json)"
REGISTRY=ghcr.io/joeblackwaslike

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty; commit first so tags map to a commit" >&2
  exit 1
fi

docker buildx build --platform linux/arm64 --push \
  -t "$REGISTRY/stealth-browser-camoufox:$CAMOUFOX_TAG" camoufox
docker buildx build --platform linux/arm64 --push \
  -t "$REGISTRY/stealth-browser-gateway:$GATEWAY_TAG" .
