#!/bin/sh
project="${TEST_COMPOSE_PROJECT:-tickethub-test-$$-$(date +%s)}"
compose() {
  docker compose -p "$project" -f docker-compose.yml -f docker-compose.test.yml "$@"
}
cleanup() {
  compose --profile test down -v --remove-orphans
}
trap cleanup EXIT
trap 'exit 130' INT TERM
echo "Proyecto de Compose de pruebas: $project"
compose up -d --build --wait &&
  compose exec -T identity-service npm run create-admin --silent &&
  compose --profile test run --rm --use-aliases tests &&
  TEST_COMPOSE_PROJECT="$project" node --test --test-reporter=spec tests-host/health-deps.test.js
status=$?
exit "$status"
