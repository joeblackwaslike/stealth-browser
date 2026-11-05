#!/usr/bin/env bash
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"

brave_key_file=""
case "${1:-}" in
  --brave-key-file)
    brave_key_file="${2:?--brave-key-file needs a path}"
    [ -s "$brave_key_file" ] || { echo "Brave key file is missing or empty: $brave_key_file" >&2; exit 1; }
    ;;
  "") ;;
  *) echo "usage: $0 [--brave-key-file <path>]" >&2; exit 1 ;;
esac

gateway_token="$(kubectl -n stealth-browser get secret stealth-browser-secrets -o jsonpath='{.data.gatewayToken}' | base64 -d)"
[ -n "$gateway_token" ] || { echo "Secret stealth-browser-secrets in namespace stealth-browser has no gatewayToken" >&2; exit 1; }

kubectl apply -f "$dir/namespace.yaml"
if ! kubectl -n searxng get secret searxng >/dev/null 2>&1; then
  openssl rand -hex 32 | tr -d '\n' |
    kubectl -n searxng create secret generic searxng --from-file=secret-key=/dev/stdin
fi
if [ -n "$brave_key_file" ]; then
  kubectl -n searxng create secret generic searxng-brave --from-file=api-key="$brave_key_file" \
    --dry-run=client -o yaml | kubectl -n searxng apply -f -
fi
printf '%s' "$gateway_token" |
  kubectl -n searxng create secret generic searxng-gateway --from-file=token=/dev/stdin \
    --dry-run=client -o yaml | kubectl -n searxng apply -f -
kubectl kustomize --load-restrictor=LoadRestrictionsNone "$dir" | kubectl apply -f -
# Reloader skips a newly created Secret and patches asynchronously on updates,
# so restart here to make the rollout wait below cover the new key.
if [ -n "$brave_key_file" ]; then
  kubectl -n searxng rollout restart deploy/searxng
fi
kubectl -n searxng rollout status deploy/searxng --timeout=180s
