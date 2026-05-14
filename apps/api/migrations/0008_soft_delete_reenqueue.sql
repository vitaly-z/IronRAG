-- 0008: allow re-upload after soft delete
--
-- `content_document` has a UNIQUE constraint on `(library_id, external_key)`
-- that blocks re-uploading a document with the same external key even after
-- the original was soft-deleted (`document_state = 'deleted'`).
--
-- Replace the unconditional unique constraint with a partial unique index
-- that only considers `active` rows.  A deleted document no longer blocks
-- its own re-upload.

-- Drop the old constraint (idempotent — IF EXISTS is not supported by PG
-- for constraints, so guard with a DO block).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_document_library_id_external_key_key'
          AND conrelid = 'content_document'::regclass
    ) THEN
        ALTER TABLE content_document
            DROP CONSTRAINT content_document_library_id_external_key_key;
    END IF;
END $$;

-- Create the partial unique index — only active rows conflict.
CREATE UNIQUE INDEX IF NOT EXISTS
    content_document_library_id_external_key_active_idx
    ON content_document (library_id, external_key)
    WHERE document_state = 'active';

-- Canonical document-processing progress lives on the latest ingest attempt.
-- Writers update it at stage transitions; list surfaces read it directly.
ALTER TABLE ingest_attempt
    ADD COLUMN IF NOT EXISTS progress_percent INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ingest_attempt
    ADD COLUMN IF NOT EXISTS failure_message TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ingest_attempt_progress_percent_range'
          AND conrelid = 'ingest_attempt'::regclass
    ) THEN
        ALTER TABLE ingest_attempt
            ADD CONSTRAINT ingest_attempt_progress_percent_range
            CHECK (progress_percent >= 0 AND progress_percent <= 100);
    END IF;
END $$;

-- Revision ingest units are the canonical durable checkpoint surface for
-- long-running revision-local work.  A unit is idempotent and owns one
-- bounded range inside one stage, so worker restarts and network failures
-- resume from the last completed unit instead of discarding hours of work.
CREATE TABLE IF NOT EXISTS content_revision_ingest_unit (
    revision_id UUID NOT NULL REFERENCES content_revision(id) ON DELETE CASCADE,
    stage_name TEXT NOT NULL,
    unit_ordinal INTEGER NOT NULL,
    unit_kind TEXT NOT NULL,
    range_start INTEGER NOT NULL,
    range_end INTEGER NOT NULL,
    unit_state TEXT NOT NULL,
    content_text TEXT,
    structure_hints_json JSONB,
    source_metadata_json JSONB,
    source_map_json JSONB,
    warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_kind TEXT,
    model_name TEXT,
    content_checksum TEXT,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempt_id UUID REFERENCES ingest_attempt(id) ON DELETE SET NULL,
    elapsed_ms BIGINT,
    failure_code TEXT,
    failure_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (revision_id, stage_name, unit_ordinal),
    CHECK (range_start > 0),
    CHECK (range_end >= range_start),
    CHECK (unit_state IN ('started', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS
    content_revision_ingest_unit_state_idx
    ON content_revision_ingest_unit (revision_id, stage_name, unit_state, unit_ordinal);

-- Runtime graph evidence text lookup is body-only.  Document/source names are
-- resolved by structured document focus and target evidence; mixing
-- source_file_name into the text index makes a focused filename query match
-- every evidence row in that document and turns answer preparation into a
-- large sort.
CREATE INDEX IF NOT EXISTS
    idx_runtime_graph_evidence_library_body_text_search
    ON runtime_graph_evidence USING gin (
        library_id,
        to_tsvector('simple'::regconfig, evidence_text)
    )
    WHERE btrim(evidence_text) <> '';

CREATE INDEX IF NOT EXISTS
    idx_runtime_graph_evidence_library_body_literal_trgm
    ON runtime_graph_evidence USING gin (
        library_id,
        lower(evidence_text) gin_trgm_ops
    )
    WHERE btrim(evidence_text) <> '';

DROP INDEX IF EXISTS idx_runtime_graph_evidence_library_text_search;
DROP INDEX IF EXISTS idx_runtime_graph_evidence_library_literal_text_trgm;

-- Assistant LLM debug snapshots are part of the canonical query execution
-- record. Operators use them to inspect the exact provider request/response
-- that produced an answer; keeping them only in process memory made the UI
-- debug button fail after restarts and on cached answer replays.
CREATE TABLE IF NOT EXISTS query_llm_context_snapshot (
    execution_id UUID PRIMARY KEY REFERENCES query_execution(id) ON DELETE CASCADE,
    snapshot_json JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS
    idx_query_llm_context_snapshot_captured
    ON query_llm_context_snapshot (captured_at DESC);
