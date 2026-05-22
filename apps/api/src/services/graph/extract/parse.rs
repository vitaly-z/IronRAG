use anyhow::{Context, Result as AnyhowResult, anyhow};

use crate::domains::runtime_graph::RuntimeNodeType;
use crate::services::graph::error::GraphServiceError;
use crate::shared::extraction::text_quality::{
    is_low_confidence_text, is_structurally_unstable_fragment,
};
use crate::shared::text_encoding::{
    contains_disallowed_controls, contains_repairable_utf8_latin1_mojibake,
    json_contains_repairable_utf8_latin1_mojibake, repair_json_string_values,
    repair_utf8_latin1_mojibake,
};

use super::types::{
    FailedNormalizationAttempt, GraphEntityCandidate, GraphExtractionCandidateSet,
    GraphExtractionTaskFailure, GraphExtractionTaskFailureCode, GraphRelationCandidate,
    NormalizedGraphExtractionAttempt,
};

pub(crate) fn normalize_graph_extraction_output(
    output_text: &str,
) -> std::result::Result<NormalizedGraphExtractionAttempt, FailedNormalizationAttempt> {
    parse_graph_extraction_output(output_text)
        .map(|normalized| NormalizedGraphExtractionAttempt {
            normalized,
            normalization_path: "direct",
        })
        .map_err(|error| FailedNormalizationAttempt { parse_error: error.to_string() })
}

pub fn parse_graph_extraction_output(
    output_text: &str,
) -> std::result::Result<GraphExtractionCandidateSet, GraphServiceError> {
    let parsed = extract_json_payload(output_text).map_err(|error| {
        GraphServiceError::ProviderUnavailable {
            message: format!(
                "{}: {error}",
                GraphExtractionTaskFailureCode::MalformedOutput.as_str()
            ),
        }
    })?;
    let entities = parsed
        .get("entities")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(parse_entity_candidate).collect::<Vec<_>>())
        .unwrap_or_default();
    let relations = parsed
        .get("relations")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(parse_relation_candidate).collect::<Vec<_>>())
        .unwrap_or_default();

    let candidate_set = GraphExtractionCandidateSet { entities, relations };
    validate_graph_extraction_candidate_set(&candidate_set).map_err(|failure| {
        GraphServiceError::ProviderUnavailable { message: failure.summary.clone() }
    })?;
    Ok(candidate_set)
}

#[must_use]
pub fn sanitize_graph_extraction_candidate_set(
    candidate_set: GraphExtractionCandidateSet,
    source_text: &str,
) -> GraphExtractionCandidateSet {
    if is_low_confidence_text(source_text) {
        return GraphExtractionCandidateSet::default();
    }

    let candidate_set = repair_graph_extraction_candidate_set(candidate_set);
    let entities = candidate_set
        .entities
        .into_iter()
        .filter_map(|mut entity| {
            if crate::services::graph::identity::is_structural_literal_label(&entity.label)
                || is_unstable_graph_label(&entity.label, source_text)
            {
                return None;
            }
            entity.aliases.retain(|alias| {
                !crate::services::graph::identity::is_structural_literal_label(alias)
                    && !is_unstable_graph_label(alias, source_text)
            });
            if entity.summary.as_deref().is_some_and(is_low_confidence_text) {
                entity.summary = None;
            }
            Some(entity)
        })
        .collect::<Vec<_>>();
    let relations = candidate_set
        .relations
        .into_iter()
        .filter_map(|mut relation| {
            if crate::services::graph::identity::is_structural_literal_label(&relation.source_label)
                || crate::services::graph::identity::is_structural_literal_label(
                    &relation.target_label,
                )
                || is_unstable_graph_label(&relation.source_label, source_text)
                || is_unstable_graph_label(&relation.target_label, source_text)
            {
                return None;
            }
            if relation.summary.as_deref().is_some_and(is_low_confidence_text) {
                relation.summary = None;
            }
            Some(relation)
        })
        .collect::<Vec<_>>();

    GraphExtractionCandidateSet { entities, relations }
}

pub(crate) fn repair_graph_extraction_candidate_set(
    candidate_set: GraphExtractionCandidateSet,
) -> GraphExtractionCandidateSet {
    let entities = candidate_set
        .entities
        .into_iter()
        .filter_map(|entity| {
            let label = repair_extracted_text(&entity.label);
            if label.is_empty() || contains_control_or_mojibake(&label) {
                return None;
            }
            let aliases = entity
                .aliases
                .into_iter()
                .map(|alias| repair_extracted_text(&alias))
                .filter(|alias| !alias.is_empty() && !contains_control_or_mojibake(alias))
                .collect::<Vec<_>>();
            let sub_type = entity
                .sub_type
                .as_deref()
                .map(repair_extracted_text)
                .filter(|value| !value.is_empty() && !contains_control_or_mojibake(value));
            let summary = entity
                .summary
                .as_deref()
                .map(repair_extracted_text)
                .filter(|value| !value.is_empty() && !contains_control_or_mojibake(value));
            Some(GraphEntityCandidate { label, aliases, sub_type, summary, ..entity })
        })
        .collect::<Vec<_>>();

    let relations = candidate_set
        .relations
        .into_iter()
        .filter_map(|relation| {
            let source_label = repair_extracted_text(&relation.source_label);
            let target_label = repair_extracted_text(&relation.target_label);
            if source_label.is_empty()
                || target_label.is_empty()
                || contains_control_or_mojibake(&source_label)
                || contains_control_or_mojibake(&target_label)
            {
                return None;
            }
            let summary = relation
                .summary
                .as_deref()
                .map(repair_extracted_text)
                .filter(|value| !value.is_empty() && !contains_control_or_mojibake(value));
            Some(GraphRelationCandidate { source_label, target_label, summary, ..relation })
        })
        .collect::<Vec<_>>();

    GraphExtractionCandidateSet { entities, relations }
}

pub(crate) fn graph_extraction_candidate_set_contains_encoding_damage(
    candidate_set: &GraphExtractionCandidateSet,
) -> bool {
    candidate_set.entities.iter().any(|entity| {
        contains_control_or_mojibake(&entity.label)
            || entity.aliases.iter().any(|alias| contains_control_or_mojibake(alias))
            || entity.sub_type.as_deref().is_some_and(contains_control_or_mojibake)
            || entity.summary.as_deref().is_some_and(contains_control_or_mojibake)
    }) || candidate_set.relations.iter().any(|relation| {
        contains_control_or_mojibake(&relation.source_label)
            || contains_control_or_mojibake(&relation.target_label)
            || relation.summary.as_deref().is_some_and(contains_control_or_mojibake)
    })
}

pub(crate) fn canonical_graph_extraction_normalized_json(
    candidate_set: GraphExtractionCandidateSet,
) -> serde_json::Value {
    let repaired = repair_graph_extraction_candidate_set(candidate_set);
    let value = serde_json::to_value(&repaired)
        .unwrap_or_else(|_| serde_json::json!({ "entities": [], "relations": [] }));
    let repaired = repair_graph_extraction_normalized_json(value);
    if json_contains_repairable_utf8_latin1_mojibake(&repaired) {
        tracing::error!(
            "graph extraction normalized output still contains encoding damage after canonical repair"
        );
        return serde_json::json!({ "entities": [], "relations": [] });
    }
    repaired
}

pub(crate) fn repair_graph_extraction_normalized_json(
    value: serde_json::Value,
) -> serde_json::Value {
    let repaired = repair_json_string_values(value);
    match serde_json::from_value::<GraphExtractionCandidateSet>(repaired.clone()) {
        Ok(candidate_set) => {
            serde_json::to_value(repair_graph_extraction_candidate_set(candidate_set))
                .unwrap_or_else(|_| serde_json::json!({ "entities": [], "relations": [] }))
        }
        Err(_) => repaired,
    }
}

/// Reject labels that contain C0/C1 control characters or look like
/// double-encoded UTF-8 (mojibake). LLM providers occasionally emit
/// `\u0090` etc. which cascade into garbled graph labels.
fn contains_control_or_mojibake(label: &str) -> bool {
    contains_disallowed_controls(label) || contains_repairable_utf8_latin1_mojibake(label)
}

fn repair_extracted_text(value: &str) -> String {
    repair_utf8_latin1_mojibake(value.trim()).trim().to_string()
}

fn is_unstable_graph_label(value: &str, source_text: &str) -> bool {
    is_tiny_unstable_graph_label(value)
        || is_low_confidence_text(value)
        || (is_structurally_unstable_fragment(value)
            && !has_symbolic_measurement_context(value, source_text))
}

fn is_tiny_unstable_graph_label(value: &str) -> bool {
    let trimmed = value.trim();
    let mut chars = trimmed.chars();
    matches!((chars.next(), chars.next()), (Some(ch), None) if ch.is_alphabetic())
}

fn has_symbolic_measurement_context(value: &str, source_text: &str) -> bool {
    let value = value.trim();
    if !is_short_mixed_script_alpha_label(value) {
        return false;
    }

    source_text.match_indices(value).any(|(offset, matched)| {
        let after = nearest_non_whitespace_after(&source_text[offset + matched.len()..]);
        has_numeric_measurement_value_before(&source_text[..offset])
            || after.is_some_and(is_formula_operator)
    })
}

fn is_short_mixed_script_alpha_label(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    if !(2..=4).contains(&chars.len()) || !chars.iter().all(|ch| ch.is_alphabetic()) {
        return false;
    }
    chars.iter().any(|ch| ch.is_ascii_alphabetic())
        && chars.iter().any(|ch| ch.is_alphabetic() && !ch.is_ascii_alphabetic())
}

fn nearest_non_whitespace_after(text: &str) -> Option<char> {
    text.chars().find(|ch| !ch.is_whitespace())
}

fn has_numeric_measurement_value_before(text: &str) -> bool {
    let chars = text.chars().collect::<Vec<_>>();
    let mut index = chars.len();
    while index > 0 && chars[index - 1].is_whitespace() {
        index -= 1;
    }
    let end = index;
    while index > 0 && (chars[index - 1].is_ascii_digit() || matches!(chars[index - 1], '.' | ','))
    {
        index -= 1;
    }
    if index == end || !chars[index..end].iter().any(|ch| ch.is_ascii_digit()) {
        return false;
    }
    if index == 0 {
        return true;
    }
    let preceding = chars[index - 1];
    !preceding.is_alphanumeric() && !matches!(preceding, '_' | '-')
}

fn is_formula_operator(ch: char) -> bool {
    matches!(ch, '=' | ':' | '+' | '-' | '*' | '/' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}')
}

pub fn validate_graph_extraction_candidate_set(
    candidate_set: &GraphExtractionCandidateSet,
) -> std::result::Result<(), GraphExtractionTaskFailure> {
    if candidate_set.entities.iter().any(|entity| entity.label.trim().is_empty())
        || candidate_set.relations.iter().any(|relation| {
            relation.source_label.trim().is_empty()
                || relation.target_label.trim().is_empty()
                || relation.relation_type.trim().is_empty()
        })
    {
        return Err(GraphExtractionTaskFailure {
            code: GraphExtractionTaskFailureCode::InvalidCandidateSet.as_str().to_string(),
            summary: "graph extraction candidate set contains empty labels or relation fields"
                .to_string(),
        });
    }

    Ok(())
}

fn refine_entity_type(label: &str, current_type: RuntimeNodeType) -> RuntimeNodeType {
    // Only refine generic "entity" types
    if current_type != RuntimeNodeType::Entity {
        return current_type;
    }

    let label_trimmed = label.trim();

    // Environment variables: ALL_CAPS_WITH_UNDERSCORES → Attribute (configuration parameters)
    if label_trimmed.len() > 2
        && label_trimmed.chars().all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
        && label_trimmed.contains('_')
    {
        return RuntimeNodeType::Attribute;
    }

    // URL paths: /api/v1/users → Artifact (human-made endpoints)
    if label_trimmed.starts_with('/') && label_trimmed.len() > 1 {
        return RuntimeNodeType::Artifact;
    }

    // HTTP methods → Artifact
    if matches!(label_trimmed, "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD") {
        return RuntimeNodeType::Artifact;
    }

    // HTTP status codes: 3 digits 100-599 → Attribute (status indicators)
    if label_trimmed.len() == 3 {
        if let Ok(code) = label_trimmed.parse::<u16>() {
            if (100..600).contains(&code) {
                return RuntimeNodeType::Attribute;
            }
        }
    }

    // File paths: ends with known extension → Artifact (human-made files)
    if label_trimmed.contains('.') {
        let ext = label_trimmed.rsplit('.').next().unwrap_or("");
        if matches!(
            ext,
            "py" | "rs"
                | "ts"
                | "tsx"
                | "js"
                | "go"
                | "java"
                | "kt"
                | "sql"
                | "md"
                | "json"
                | "yaml"
                | "yml"
                | "toml"
                | "xml"
                | "html"
                | "css"
                | "tf"
                | "pdf"
                | "docx"
                | "xls"
                | "xlsx"
                | "xlsb"
                | "ods"
                | "pptx"
                | "pkl"
                | "csv"
        ) {
            return RuntimeNodeType::Artifact;
        }
    }

    // URLs → Artifact
    if label_trimmed.starts_with("http://") || label_trimmed.starts_with("https://") {
        return RuntimeNodeType::Artifact;
    }

    current_type
}

fn parse_entity_candidate(value: &serde_json::Value) -> Option<GraphEntityCandidate> {
    let label = repair_extracted_text(value.get("label").and_then(serde_json::Value::as_str)?);
    if label.is_empty() || contains_control_or_mojibake(&label) {
        return None;
    }
    let node_type = parse_canonical_node_type(value.get("node_type")?.as_str()?.trim())?;
    let aliases = value
        .get("aliases")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(repair_extracted_text)
                .filter(|item| !item.is_empty())
                .filter(|item| !contains_control_or_mojibake(item))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let node_type = refine_entity_type(&label, node_type);
    let sub_type = value
        .get("sub_type")
        .and_then(serde_json::Value::as_str)
        .map(repair_extracted_text)
        .filter(|s| !s.is_empty())
        .filter(|s| !contains_control_or_mojibake(s));
    let summary = value
        .get("summary")
        .and_then(serde_json::Value::as_str)
        .map(repair_extracted_text)
        .filter(|item| !item.is_empty())
        .filter(|item| !contains_control_or_mojibake(item));

    Some(GraphEntityCandidate { label, node_type, sub_type, aliases, summary })
}

fn parse_relation_candidate(value: &serde_json::Value) -> Option<GraphRelationCandidate> {
    let source_label =
        repair_extracted_text(value.get("source_label").and_then(serde_json::Value::as_str)?);
    let target_label =
        repair_extracted_text(value.get("target_label").and_then(serde_json::Value::as_str)?);
    let relation_type = value.get("relation_type").and_then(serde_json::Value::as_str)?.trim();
    if source_label.is_empty()
        || target_label.is_empty()
        || relation_type.is_empty()
        || contains_control_or_mojibake(&source_label)
        || contains_control_or_mojibake(&target_label)
    {
        return None;
    }
    let relation_slug =
        crate::services::graph::identity::normalize_graph_identity_component(relation_type);
    if crate::services::graph::identity::is_noise_relation_type(&relation_slug) {
        return None;
    }
    let normalized_relation_type = canonical_relation_candidate_type(relation_type)?;

    Some(GraphRelationCandidate {
        source_label,
        target_label,
        relation_type: normalized_relation_type,
        summary: value
            .get("summary")
            .and_then(serde_json::Value::as_str)
            .map(repair_extracted_text)
            .filter(|item| !item.is_empty())
            .filter(|item| !contains_control_or_mojibake(item)),
    })
}

fn canonical_relation_candidate_type(relation_type: &str) -> Option<String> {
    if relation_type.is_empty()
        || !relation_type_is_canonical_ascii(relation_type)
        || !crate::services::graph::identity::is_canonical_relation_type(relation_type)
    {
        return None;
    }
    Some(relation_type.to_string())
}

fn relation_type_is_canonical_ascii(relation_type: &str) -> bool {
    relation_type.bytes().all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

fn parse_canonical_node_type(raw: &str) -> Option<RuntimeNodeType> {
    match raw {
        "person" => Some(RuntimeNodeType::Person),
        "organization" => Some(RuntimeNodeType::Organization),
        "location" => Some(RuntimeNodeType::Location),
        "event" => Some(RuntimeNodeType::Event),
        "artifact" => Some(RuntimeNodeType::Artifact),
        "natural" => Some(RuntimeNodeType::Natural),
        "process" => Some(RuntimeNodeType::Process),
        "concept" => Some(RuntimeNodeType::Concept),
        "attribute" => Some(RuntimeNodeType::Attribute),
        "entity" => Some(RuntimeNodeType::Entity),
        _ => None,
    }
}

fn extract_json_payload(output_text: &str) -> AnyhowResult<serde_json::Value> {
    let repaired_output = repair_utf8_latin1_mojibake(output_text);
    if repaired_output != output_text {
        tracing::warn!(
            original_chars = output_text.chars().count(),
            repaired_chars = repaired_output.chars().count(),
            "graph extraction provider output encoding repaired before JSON parse"
        );
    }
    let trimmed = repaired_output.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("graph extraction output is empty"));
    }
    serde_json::from_str::<serde_json::Value>(trimmed).context("invalid graph extraction json")
}

#[cfg(test)]
mod tests {
    use crate::{
        domains::runtime_graph::RuntimeNodeType,
        services::graph::extract::{
            parse::{has_symbolic_measurement_context, sanitize_graph_extraction_candidate_set},
            types::{GraphEntityCandidate, GraphExtractionCandidateSet, GraphRelationCandidate},
        },
    };

    #[test]
    fn graph_sanitizer_removes_short_ocr_noise_labels_without_dropping_identifiers() {
        let candidate_set = GraphExtractionCandidateSet {
            entities: vec![
                entity("HARBOR-SIGNAL-42"),
                entity("ALPHA_TIMEOUT_MS"),
                entity("μs"),
                entity("ΔT"),
                entity("CTpoKe"),
                entity("Enμα"),
                entity("∑nμα"),
                entity("μe"),
                entity("B"),
            ],
            relations: vec![
                relation("HARBOR-SIGNAL-42", "ALPHA_TIMEOUT_MS"),
                relation("ALPHA_TIMEOUT_MS", "μs"),
                relation("ΔT", "ALPHA_TIMEOUT_MS"),
                relation("CTpoKe", "ALPHA_TIMEOUT_MS"),
                relation("HARBOR-SIGNAL-42", "Enμα"),
                relation("μe", "ALPHA_TIMEOUT_MS"),
                relation("B", "ALPHA_TIMEOUT_MS"),
            ],
        };

        let sanitized = sanitize_graph_extraction_candidate_set(
            candidate_set,
            "HARBOR-SIGNAL-42 ALPHA_TIMEOUT_MS latency = 10 μs and ΔT=5 CTpoKe Enμα ∑nμα μe B",
        );

        let labels =
            sanitized.entities.iter().map(|entity| entity.label.as_str()).collect::<Vec<_>>();
        assert_eq!(labels, vec!["HARBOR-SIGNAL-42", "ALPHA_TIMEOUT_MS", "μs", "ΔT"]);
        assert_eq!(sanitized.relations.len(), 3);
        assert_eq!(sanitized.relations[0].source_label, "HARBOR-SIGNAL-42");
        assert_eq!(sanitized.relations[0].target_label, "ALPHA_TIMEOUT_MS");
        assert_eq!(sanitized.relations[1].source_label, "ALPHA_TIMEOUT_MS");
        assert_eq!(sanitized.relations[1].target_label, "μs");
        assert_eq!(sanitized.relations[2].source_label, "ΔT");
        assert_eq!(sanitized.relations[2].target_label, "ALPHA_TIMEOUT_MS");
    }

    #[test]
    fn measurement_context_requires_numeric_value_not_code_identifier_suffix() {
        assert!(has_symbolic_measurement_context("μs", "latency = 10 μs"));
        assert!(has_symbolic_measurement_context("ΔT", "ΔT = 5"));
        assert!(!has_symbolic_measurement_context("μe", "NODE_ALPHA-42 μe"));
    }

    #[test]
    fn graph_sanitizer_removes_structural_literal_entities_and_relations() {
        let candidate_set = GraphExtractionCandidateSet {
            entities: vec![
                entity("Alpha Switch"),
                entity("false"),
                entity("42"),
                entity("3.12.4"),
                entity("Alpha false mode"),
            ],
            relations: vec![
                relation("Alpha Switch", "Alpha false mode"),
                relation("Alpha Switch", "false"),
                relation("false", "Alpha Switch"),
                relation("42", "Alpha Switch"),
            ],
        };

        let sanitized = sanitize_graph_extraction_candidate_set(
            candidate_set,
            "Alpha Switch supports Alpha false mode with values false, 42, and 3.12.4.",
        );

        let labels =
            sanitized.entities.iter().map(|entity| entity.label.as_str()).collect::<Vec<_>>();
        assert_eq!(labels, vec!["Alpha Switch", "42", "3.12.4", "Alpha false mode"]);
        assert_eq!(sanitized.relations.len(), 2);
        assert_eq!(sanitized.relations[0].target_label, "Alpha false mode");
        assert_eq!(sanitized.relations[1].source_label, "42");
    }

    fn entity(label: &str) -> GraphEntityCandidate {
        GraphEntityCandidate {
            label: label.to_string(),
            node_type: RuntimeNodeType::Artifact,
            sub_type: None,
            aliases: Vec::new(),
            summary: None,
        }
    }

    fn relation(source_label: &str, target_label: &str) -> GraphRelationCandidate {
        GraphRelationCandidate {
            source_label: source_label.to_string(),
            target_label: target_label.to_string(),
            relation_type: "uses".to_string(),
            summary: None,
        }
    }
}
