#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="${NOTES_PROJECT_NAME:-notes-production}"
PRODUCTION_FILE="${ROOT_DIR}/docker-compose.production.yml"
TEST_FILE="${ROOT_DIR}/docker-compose.test.yml"
WAIT_TIMEOUT="${DEPLOY_WAIT_TIMEOUT:-90}"
SKIP_TESTS="${SKIP_TESTS:-0}"

PRODUCTION=(docker compose -p "${PROJECT_NAME}" -f "${PRODUCTION_FILE}")
TESTS=(docker compose -f "${TEST_FILE}")

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

show_failure_context() {
  local exit_code=$?
  printf '\nDeploy interrompido (código %s).\n' "${exit_code}" >&2
  "${PRODUCTION[@]}" ps >&2 || true
  "${PRODUCTION[@]}" logs --tail=100 notes >&2 || true
  exit "${exit_code}"
}

trap show_failure_context ERR

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker não encontrado.\n' >&2
  exit 1
fi

docker info >/dev/null
docker compose version >/dev/null

log "Validando configurações Docker Compose"
"${PRODUCTION[@]}" config --quiet
"${TESTS[@]}" config --quiet

if [[ "${SKIP_TESTS}" != "1" ]]; then
  log "Executando testes em container isolado"
  "${TESTS[@]}" run --build --rm tests
else
  log "Testes ignorados por SKIP_TESTS=1"
fi

log "Construindo imagem de produção"
"${PRODUCTION[@]}" build --pull notes

log "Atualizando serviços de produção"
"${PRODUCTION[@]}" up -d --remove-orphans --force-recreate

container_id="$("${PRODUCTION[@]}" ps -q notes)"
if [[ -z "${container_id}" ]]; then
  printf 'Container de produção não foi criado.\n' >&2
  exit 1
fi

log "Aguardando healthcheck por até ${WAIT_TIMEOUT}s"
deadline=$((SECONDS + WAIT_TIMEOUT))
while (( SECONDS < deadline )); do
  status="$(
    docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "${container_id}"
  )"

  case "${status}" in
    healthy)
      break
      ;;
    unhealthy|exited|dead)
      printf 'Container entrou no estado %s.\n' "${status}" >&2
      exit 1
      ;;
  esac

  sleep 2
done

if [[ "${status}" != "healthy" ]]; then
  printf 'Healthcheck não ficou saudável dentro do limite.\n' >&2
  exit 1
fi

bind_address="${NOTES_BIND_ADDRESS:-127.0.0.1}"
published_port="${NOTES_PORT:-3001}"

trap - ERR
log "Deploy concluído com sucesso"
printf 'Aplicação: http://%s:%s\n' "${bind_address}" "${published_port}"
printf 'Status: %s\n' "${status}"
printf '\nNo primeiro acesso, consulte o token com:\n'
printf 'docker compose -p %q -f %q run --rm setup cat /secrets/admin-setup-token\n' \
  "${PROJECT_NAME}" "${PRODUCTION_FILE}"
