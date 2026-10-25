#!/usr/bin/env bash
# Deploy stealth-browser to the k3s cluster. Requires kubectl, jq, openssl.
set -euo pipefail
cd "$(dirname "$0")/.."

NS=stealth-browser

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

# Reuse the working pull secret from ai-listings on every run.
kubectl get secret ghcr-credentials -n ai-listings -o json \
  | jq 'del(.metadata.namespace,.metadata.resourceVersion,.metadata.uid,.metadata.creationTimestamp,.metadata.ownerReferences,.metadata.managedFields,.metadata.annotations)' \
  | kubectl apply -n "$NS" -f -

# Generate secrets once; never rotate on redeploy.
if ! kubectl get secret stealth-browser-secrets -n "$NS" >/dev/null 2>&1; then
  # Plain assignments so set -e stops on an openssl failure; inside the
  # kubectl arguments a failed substitution would create empty secrets.
  gateway_token="$(openssl rand -hex 24)"
  ws_path="$(openssl rand -hex 24)"
  [[ ${#gateway_token} -eq 48 && ${#ws_path} -eq 48 ]] || { echo "openssl produced no secret" >&2; exit 1; }
  kubectl create secret generic stealth-browser-secrets -n "$NS" \
    --from-literal=gatewayToken="$gateway_token" \
    --from-literal=wsPath="$ws_path"
fi

# The fingerprint lives outside deploy/k8s, so kustomize needs its load restrictor off.
kubectl kustomize --load-restrictor=LoadRestrictionsNone deploy/k8s | kubectl apply -f -
kubectl -n "$NS" rollout status deploy/camoufox --timeout=300s
kubectl -n "$NS" rollout status deploy/gateway --timeout=300s

echo "Read the token with:"
echo "  kubectl get secret stealth-browser-secrets -n $NS -o jsonpath='{.data.gatewayToken}' | base64 -d"
