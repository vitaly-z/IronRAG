-- 0012 — document_hint surface for citations.
--
-- Adds two fields that together expose a "where this came from" hint to
-- MCP agents and the built-in answer pipeline:
--
--   content_revision.document_hint TEXT
--     Free-form per-revision label. Connectors and the manual upload form
--     can set it to a canonical browser URL (a wiki page, a sharepoint
--     link) or to any short label ("Q3 financial report, 2025"). When
--     NULL, the resolver falls back to source_uri for web_page revisions,
--     then to the document title. Length-capped to 1024 chars.
--
--   catalog_library.include_document_hint_in_mcp_answers BOOLEAN
--     Per-library opt-out. Defaults to TRUE: agents calling the
--     grounded_answer MCP tool against this library will see a
--     `document_hint` in each citation. When FALSE, the citation payload
--     omits the field entirely. The internal `source_uri` is never
--     surfaced to the agent regardless.
--
-- Both statements are idempotent so a startup retry against a partially
-- applied schema does not fail.

ALTER TABLE content_revision
    ADD COLUMN IF NOT EXISTS document_hint TEXT
        CHECK (document_hint IS NULL OR length(document_hint) <= 1024);

ALTER TABLE catalog_library
    ADD COLUMN IF NOT EXISTS include_document_hint_in_mcp_answers BOOLEAN
        NOT NULL DEFAULT TRUE;
