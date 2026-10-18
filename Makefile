# InboxPilot. On Windows without make, the README lists the equivalent commands.

ifeq ($(OS),Windows_NT)
AGENT_PY ?= .venv/Scripts/python
else
AGENT_PY ?= .venv/bin/python
endif

.PHONY: help dev down logs ps clean up setup test test-agent test-api test-web lint lint-agent lint-api lint-web e2e eval

help:            ## list targets
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-12s %s\n", $$1, $$2}'

# ---------------------------------------------------------------- run
dev:             ## build + start the whole stack, then open http://localhost:5173
	docker compose up --build -d --wait
	@echo "InboxPilot is up: http://localhost:5173  (API http://localhost:4000/api/health)"

down:            ## stop the stack (data volume kept)
	docker compose down

logs:            ## follow service logs
	docker compose logs -f agent api web

ps:
	docker compose ps

clean:           ## stop and DELETE all local data (Postgres volume)
	docker compose down -v

up:              ## only Postgres + Redis (for running services from source)
	docker compose up -d --wait postgres redis

# ---------------------------------------------------------------- develop from source
setup:           ## install dependencies for all three services
	cd services/agent && python -m venv .venv && $(AGENT_PY) -m pip install -r requirements-dev.txt
	cd services/api && npm ci && npx prisma generate
	cd apps/web && npm ci

# ---------------------------------------------------------------- quality
test: test-agent test-api test-web   ## every unit/integration suite

test-agent:
	cd services/agent && $(AGENT_PY) -m pytest --cov

test-api: up
	cd services/api && npm run test:cov

test-web:
	cd apps/web && npm run test:cov

lint: lint-agent lint-api lint-web   ## lint + type-check everything

lint-agent:
	cd services/agent && $(AGENT_PY) -m ruff check app tests evals && $(AGENT_PY) -m ruff format --check app tests evals && $(AGENT_PY) -m mypy

lint-api:
	cd services/api && npm run lint && npm run typecheck

lint-web:
	cd apps/web && npm run lint && npm run typecheck

e2e: up          ## Playwright against the real stack (desktop + 375 px)
	cd apps/web && npx playwright test

eval:            ## precision / recall / date accuracy per configured LLM provider
	cd services/agent && $(AGENT_PY) -m evals.run_evals --verbose
