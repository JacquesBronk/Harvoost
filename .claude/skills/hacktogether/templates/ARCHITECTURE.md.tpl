# Architecture — {{slug}}

## Stack
- Language/runtime: {{e.g., Python 3.11, Node 20}}
- Backend framework: {{e.g., FastAPI}}
- Frontend framework: {{e.g., React + Vite, or "none"}}
- Database: {{e.g., Postgres 15, or SQLite for dev}}
- Container: {{Dockerfile + docker-compose}}
- Rationale: {{one paragraph: why this stack for these requirements}}

## Modules
- `src/api/` — {{purpose}}
- `src/db/` — {{purpose}}
- `src/ui/` — {{purpose}} (omit if no frontend)
- `tests/` — {{purpose}}

## Data flow
{{ASCII or numbered diagram of request → response path}}

## Key design decisions
- {{decision}} — chosen because {{reason}}; alternative considered: {{alt}}

## Concerns / flags for HITL approval
- {{concern}} — {{why it matters}}

## What downstream agents need to know
- {{things api-designer, builders, etc. should be aware of}}
