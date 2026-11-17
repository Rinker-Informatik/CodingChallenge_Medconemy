#!/bin/sh
set -eu
: "${CHROMIUM_PATH:?Pfad zur lokalen Chrome- oder Chromium-Datei setzen}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
WORK=$(mktemp -d)
PROJECT="medconemyoffice$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
export OFFICE_SECRET=$(openssl rand -hex 32)
export OFFICE_BROWSER_ORIGIN=http://localhost:8082
compose() {
  docker compose -p "$PROJECT" -f src/backend/docker-compose.yml -f deployment/compose.ui.yml -f deployment/compose.office.yml "$@"
}
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -rf "$WORK"
  if [ "$status" -ne 0 ]; then compose logs --tail=30 || true; fi
  compose down --volumes --remove-orphans || exit 1
  for service in backend ui; do
    image="$PROJECT-$service"
    if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" || exit 1; fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
printf 'Isoliertes Compose-Projekt: %s\n' "$PROJECT"
npm install --prefix "$WORK" --no-save --no-package-lock playwright-core@1.56.1 fflate@0.8.2
cp tests/invitation-helpers.mjs tests/accounts.smoke.mjs tests/dragdrop.smoke.mjs tests/office.smoke.mjs tests/permissions.smoke.mjs tests/ui.smoke.mjs "$WORK/"
compose up -d --build
ready=false
for attempt in $(seq 1 100); do
  if compose exec -T office curl -fsS http://127.0.0.1/healthcheck 2>/dev/null | grep -qx true; then
    ready=true
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  printf '%s\n' 'ONLYOFFICE wurde nicht rechtzeitig bereit.' >&2
  exit 1
fi
CHROMIUM_PATH="$CHROMIUM_PATH" OFFICE_TEST_ADMIN_PASSWORD=demo-admin-password UI_URL=http://localhost:8080 MAIL_URL=http://localhost:8026 \
  node --test --test-concurrency=1 "$WORK/ui.smoke.mjs" "$WORK/permissions.smoke.mjs" "$WORK/dragdrop.smoke.mjs" "$WORK/accounts.smoke.mjs" "$WORK/office.smoke.mjs"
