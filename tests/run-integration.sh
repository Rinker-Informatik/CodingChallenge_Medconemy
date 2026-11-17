#!/bin/sh
set -eu
TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT="medconemytest$(node -e 'process.stdout.write(require("crypto").randomBytes(12).toString("hex"))')"
MODE="${1:-}"
case "$MODE" in
  '') set -- -f "$TEST_DIR/compose.integration.yml" ;;
  --ui) set -- -f "$TEST_DIR/compose.integration.yml" -f "$TEST_DIR/compose.ui-smoke.yml" ;;
  --office)
    export OFFICE_SECRET=onlyoffice-isolated-integration-secret
    set -- -f "$TEST_DIR/compose.integration.yml" -f "$TEST_DIR/compose.ui-smoke.yml" -f "$TEST_DIR/compose.office-smoke.yml" ;;
  *) printf '%s\n' 'Aufruf: tests/run-integration.sh [--ui|--office]' >&2; exit 2 ;;
esac

compose() {
  docker compose -p "$PROJECT" "$@"
}
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  case "$MODE" in
    '') set -- -f "$TEST_DIR/compose.integration.yml" ;;
    --ui) set -- -f "$TEST_DIR/compose.integration.yml" -f "$TEST_DIR/compose.ui-smoke.yml" ;;
    --office) set -- -f "$TEST_DIR/compose.integration.yml" -f "$TEST_DIR/compose.ui-smoke.yml" -f "$TEST_DIR/compose.office-smoke.yml" ;;
  esac
  if [ "$status" -ne 0 ]; then
    compose "$@" logs --no-color 2>&1 || true
  fi
  if ! compose "$@" --profile test down --volumes --remove-orphans; then
    printf '%s\n' "Aufräumen fehlgeschlagen; isoliertes Compose-Projekt: $PROJECT" >&2
    exit 1
  fi
  for service in backend ui browser-test; do
    image="$PROJECT-$service"
    if docker image inspect "$image" >/dev/null 2>&1; then
      docker image rm "$image" || exit 1
    fi
  done
  exit "$status"
}
trap 'cleanup "$@"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
printf 'Isoliertes Compose-Projekt: %s\n' "$PROJECT"
compose "$@" up -d --build
compose "$@" --profile test run --rm --no-deps test
if [ "$MODE" = --office ]; then
  compose "$@" up -d --wait --wait-timeout 220 office
fi
if [ -n "$MODE" ]; then
  compose "$@" --profile test run --build --rm --no-deps browser-test
fi
