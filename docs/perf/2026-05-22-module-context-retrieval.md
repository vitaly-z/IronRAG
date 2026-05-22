# Module Context Retrieval Verification

Date: 2026-05-22

Scope: local Docker stack against an internal benchmark corpus. Corpus-specific
names, documents, provider labels, and concrete user questions are intentionally
omitted.

Change under test:

- Query compilation now has canonical target tags for modules, packages,
  configuration files, and filesystem paths.
- Technical-literal context selection treats those target tags as exact
  identifier evidence, so broad comparison and setup questions retain the
  identifiers needed for a grounded final answer.
- Retrieved document briefs keep a slightly wider introductory preview within
  the existing context budget, preserving near-intro technical identifiers
  without adding retrieval fan-out.

Verification evidence:

- `cargo fmt -p ironrag-backend`
- `cargo test -p ironrag-backend services::query::execution --lib`: 451 passed.
- `git diff --check`
- `docker compose -f docker-compose-local.yml build backend frontend`: passed.
- `docker compose -f docker-compose-local.yml up -d --force-recreate backend worker frontend`: passed; stateful services stayed running.
- `GET /v1/ready`: ready.

Agent-surface probes:

| Scenario | UI result | Direct MCP result | Notes |
|---|---:|---:|---|
| Broad variant comparison with module/config facets | verified, 17.6s / 1.9s, 63 refs | verified, 82 refs | Required module identifiers present after final Docker rebuild. |
| Focused configuration instructions | verified, 10.7s / 2.0s, 64 refs | verified, 65 refs | Required file, parameter, and section artifacts present. |
| Prefix-style package inventory | verified, 2.4s / 1.9s, 65 refs | verified, 65 refs | Graph-backed inventory remained fast and parity overlap stayed complete. |

All probes stayed below the 30s completed-turn budget and passed UI/MCP
verification parity gates.
