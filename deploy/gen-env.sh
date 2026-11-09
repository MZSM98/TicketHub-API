#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-.env}"
SRC="$(dirname "$0")/../.env.example"

if [ -e "$OUT" ]; then
  echo "$OUT ya existe; no se sobrescribe" >&2
  exit 1
fi

umask 077
while IFS= read -r line; do
  case "$line" in
    PAYMENT_NAMESPACE=)
      echo "PAYMENT_NAMESPACE=$(openssl rand -hex 8)"
      ;;
    *=change-me*|*=sk_test_replace_me)
      key="${line%%=*}"
      if [ "$key" = "STRIPE_SECRET_KEY" ]; then
        echo "$key=sk_test_replace_me"
      else
        echo "$key=$(openssl rand -hex 24)"
      fi
      ;;
    *) echo "$line" ;;
  esac
done < "$SRC" > "$OUT"
echo "Generado $OUT"
