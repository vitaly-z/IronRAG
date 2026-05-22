# Focused Procedural Retrieval Verification

Date: 2026-05-22

Scope: local Docker stack against an internal benchmark corpus. Corpus-specific
names, documents, and provider labels are intentionally omitted.

Change under test:

- Document-scoped comparison and procedural retrieval keep the focused source as
  the leading graph/lexical anchor before typed facets, with entity fallback
  when the focused graph profile is absent.
- Focused-document heading extraction abstains for typed procedural
  configuration questions, so deterministic preflight cannot return a heading
  instead of grounded setup instructions.

Verification evidence:

- `cargo fmt -p ironrag-backend`
- `cargo test -p ironrag-backend focused_document --lib`: 30 passed.
- `cargo test -p ironrag-backend services::query::execution --lib`: 449 passed.
- `docker compose -f docker-compose-local.yml build backend frontend`: passed.
- `docker compose -f docker-compose-local.yml up -d --force-recreate backend worker frontend`: passed; stateful services stayed running.
- `GET /v1/ready`: ready.

Agent-surface probes:

| Scenario | UI result | Direct MCP result | Notes |
|---|---:|---:|---|
| Focused configuration instructions | verified, 10.2s / 1.9s, 64 refs | verified, 64 refs | Required file, section, and parameter artifacts present after final Docker rebuild. |
| Focused variant comparison | verified, 17.2s, 63 refs | verified, 82 refs | Source anchor retained while comparing facets. |
| Recent change enumeration | verified, 2.6s, 95 refs | verified, 95 refs | Requested latest-N style answer stayed complete. |
| Prefix-style artifact inventory | verified, 2.7s, 64 refs | verified, 64 refs | Graph-backed inventory remained fast. |
| Artifact purpose follow-up | verified, 3.7s, 49 refs | verified, 49 refs | Dense inventory follow-up retained prior context. |
| Integration constraints | verified, 11.6s, 25 refs | verified, 37 refs | Multi-source constraints stayed grounded. |

All probes stayed below the 30s completed-turn budget and passed UI/MCP
verification parity gates.
