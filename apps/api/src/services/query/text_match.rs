use std::collections::{BTreeSet, HashMap};

pub(crate) use crate::shared::text_tokens::{
    normalized_alnum_token_sequence, normalized_alnum_tokens,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RelatedTokenSelection {
    tokens: BTreeSet<String>,
    mode: RelatedTokenMatchMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RelatedTokenCandidate {
    token_sequence: Vec<String>,
    tokens: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelatedTokenMatchMode {
    Exact,
    Near,
    Prefix,
}

impl RelatedTokenSelection {
    pub(crate) fn empty() -> Self {
        Self { tokens: BTreeSet::new(), mode: RelatedTokenMatchMode::Exact }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    pub(crate) fn matches_tokens(&self, label_tokens: &BTreeSet<String>) -> bool {
        match self.mode {
            RelatedTokenMatchMode::Exact => {
                self.tokens.iter().any(|target_token| label_tokens.contains(target_token))
            }
            RelatedTokenMatchMode::Near => self.tokens.iter().any(|target_token| {
                label_tokens.iter().any(|label_token| near_token_match(target_token, label_token))
            }),
            RelatedTokenMatchMode::Prefix => self.tokens.iter().any(|target_token| {
                label_tokens
                    .iter()
                    .any(|label_token| related_prefix_token_match(target_token, label_token))
            }),
        }
    }
}

pub(crate) fn token_sequence_contains(haystack: &str, needle: &str, min_chars: usize) -> bool {
    let needle_tokens = normalized_alnum_token_sequence(needle, min_chars);
    if needle_tokens.is_empty() {
        return false;
    }
    let haystack_tokens = normalized_alnum_token_sequence(haystack, min_chars);
    token_sequence_contains_tokens(&haystack_tokens, &needle_tokens)
}

pub(crate) fn token_sequence_exact_or_contains(left: &str, right: &str, min_chars: usize) -> bool {
    token_sequence_contains(left, right, min_chars)
        || token_sequence_contains(right, left, min_chars)
}

pub(crate) fn token_sequence_exact_or_contains_tokens(
    left_tokens: &[String],
    right_tokens: &[String],
) -> bool {
    token_sequence_contains_tokens(left_tokens, right_tokens)
        || token_sequence_contains_tokens(right_tokens, left_tokens)
}

pub(crate) fn near_token_match(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left_len = left.chars().count();
    let right_len = right.chars().count();
    if left_len < 5 || right_len < 5 || left_len.abs_diff(right_len) > 1 {
        return false;
    }
    if left.chars().next() != right.chars().next() {
        return false;
    }
    bounded_edit_distance_at_most_one(left, right)
}

pub(crate) fn related_prefix_token_match(target_token: &str, label_token: &str) -> bool {
    if target_token == label_token {
        return true;
    }
    let target_len = target_token.chars().count();
    let label_len = label_token.chars().count();
    if target_len < 5 || label_len <= target_len {
        return false;
    }
    let common_prefix = common_prefix_char_count(target_token, label_token);
    common_prefix >= 4 && common_prefix.saturating_add(1) >= target_len
}

pub(crate) fn near_token_overlap_count(left: &BTreeSet<String>, right: &BTreeSet<String>) -> usize {
    left.iter()
        .filter(|left_token| {
            right.iter().any(|right_token| near_token_match(left_token, right_token))
        })
        .count()
}

pub(crate) fn common_prefix_char_count(left: &str, right: &str) -> usize {
    left.chars().zip(right.chars()).take_while(|(left, right)| left == right).count()
}

pub(crate) fn build_related_token_candidates<I, S>(
    candidate_labels: I,
    min_chars: usize,
) -> Vec<RelatedTokenCandidate>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    candidate_labels
        .into_iter()
        .filter_map(|candidate_label| {
            let label = candidate_label.as_ref().trim();
            if label.is_empty() {
                return None;
            }
            let token_sequence = normalized_alnum_token_sequence(label, min_chars);
            if token_sequence.is_empty() {
                return None;
            }
            let tokens = token_sequence.iter().cloned().collect::<BTreeSet<_>>();
            Some(RelatedTokenCandidate { token_sequence, tokens })
        })
        .collect()
}

pub(crate) fn select_related_overlap_tokens_from_candidates(
    target_label: &str,
    candidates: &[RelatedTokenCandidate],
    min_chars: usize,
) -> RelatedTokenSelection {
    let target_sequence = normalized_alnum_token_sequence(target_label, min_chars);
    if target_sequence.is_empty() {
        return RelatedTokenSelection::empty();
    }
    let target_tokens = target_sequence.iter().cloned().collect::<BTreeSet<_>>();
    let mut exact_frequencies =
        target_tokens.iter().map(|token| (token.clone(), 0usize)).collect::<HashMap<_, _>>();
    let mut near_frequencies = exact_frequencies.clone();
    let mut prefix_frequencies = exact_frequencies.clone();
    let mut prefix_match_label_tokens = target_tokens
        .iter()
        .map(|token| (token.clone(), BTreeSet::new()))
        .collect::<HashMap<_, _>>();

    for candidate in candidates {
        if token_sequence_contains_tokens(&candidate.token_sequence, &target_sequence)
            || token_sequence_contains_tokens(&target_sequence, &candidate.token_sequence)
        {
            continue;
        }
        for target_token in &target_tokens {
            if candidate.tokens.contains(target_token) {
                *exact_frequencies.entry(target_token.clone()).or_insert(0) += 1;
            } else if candidate
                .tokens
                .iter()
                .any(|label_token| near_token_match(target_token, label_token))
            {
                *near_frequencies.entry(target_token.clone()).or_insert(0) += 1;
            } else {
                let matching_label_tokens = candidate
                    .tokens
                    .iter()
                    .filter(|label_token| related_prefix_token_match(target_token, label_token))
                    .cloned()
                    .collect::<Vec<_>>();
                if !matching_label_tokens.is_empty() {
                    *prefix_frequencies.entry(target_token.clone()).or_insert(0) += 1;
                    let label_tokens =
                        prefix_match_label_tokens.entry(target_token.clone()).or_default();
                    label_tokens.extend(matching_label_tokens);
                }
            }
        }
    }

    if let Some(tokens) = select_min_frequency_tokens(&exact_frequencies, &target_sequence) {
        return RelatedTokenSelection { tokens, mode: RelatedTokenMatchMode::Exact };
    }
    if let Some(tokens) = select_min_frequency_tokens(&near_frequencies, &target_sequence) {
        return RelatedTokenSelection { tokens, mode: RelatedTokenMatchMode::Near };
    }
    let coherent_prefix_frequencies = prefix_frequencies
        .iter()
        .filter_map(|(token, frequency)| {
            let label_tokens = prefix_match_label_tokens.get(token)?;
            prefix_match_label_tokens_are_coherent(label_tokens)
                .then_some((token.clone(), *frequency))
        })
        .collect::<HashMap<_, _>>();
    if let Some(tokens) =
        select_min_frequency_tokens(&coherent_prefix_frequencies, &target_sequence)
    {
        return RelatedTokenSelection { tokens, mode: RelatedTokenMatchMode::Prefix };
    }
    RelatedTokenSelection::empty()
}

fn prefix_match_label_tokens_are_coherent(label_tokens: &BTreeSet<String>) -> bool {
    match label_tokens.len() {
        0 => false,
        1 => true,
        _ => {
            let Some(shortest) = label_tokens.iter().min_by_key(|token| token.chars().count())
            else {
                return false;
            };
            label_tokens.iter().all(|token| token.starts_with(shortest))
        }
    }
}

pub(crate) fn token_sequence_contains_tokens(
    haystack_tokens: &[String],
    needle_tokens: &[String],
) -> bool {
    if needle_tokens.is_empty() || haystack_tokens.len() < needle_tokens.len() {
        return false;
    }
    haystack_tokens.windows(needle_tokens.len()).any(|window| window == needle_tokens)
}

fn select_min_frequency_tokens(
    frequencies: &HashMap<String, usize>,
    target_sequence: &[String],
) -> Option<BTreeSet<String>> {
    let min_positive_frequency =
        frequencies.values().copied().filter(|frequency| *frequency > 0).min()?;
    let mut selected = BTreeSet::new();
    if let Some(token) = target_sequence
        .iter()
        .rev()
        .find(|token| frequencies.get(*token).copied() == Some(min_positive_frequency))
    {
        selected.insert(token.clone());
    }
    if selected.is_empty() { None } else { Some(selected) }
}

fn bounded_edit_distance_at_most_one(left: &str, right: &str) -> bool {
    let left_chars = left.chars().collect::<Vec<_>>();
    let right_chars = right.chars().collect::<Vec<_>>();
    if left_chars == right_chars {
        return true;
    }
    match left_chars.len().cmp(&right_chars.len()) {
        std::cmp::Ordering::Equal => {
            left_chars.iter().zip(right_chars.iter()).filter(|(left, right)| left != right).count()
                <= 1
        }
        std::cmp::Ordering::Less => one_insert_or_delete_apart(&left_chars, &right_chars),
        std::cmp::Ordering::Greater => one_insert_or_delete_apart(&right_chars, &left_chars),
    }
}

fn one_insert_or_delete_apart(shorter: &[char], longer: &[char]) -> bool {
    if longer.len() != shorter.len() + 1 {
        return false;
    }
    let mut short_index = 0;
    let mut long_index = 0;
    let mut edits = 0;
    while short_index < shorter.len() && long_index < longer.len() {
        if shorter[short_index] == longer[long_index] {
            short_index += 1;
            long_index += 1;
        } else {
            edits += 1;
            if edits > 1 {
                return false;
            }
            long_index += 1;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn near_token_match_accepts_single_edit_for_long_tokens() {
        assert!(near_token_match("targetnme", "targetname"));
        assert!(near_token_match("paymant", "payment"));
    }

    #[test]
    fn near_token_match_rejects_short_or_distant_tokens() {
        assert!(!near_token_match("api", "app"));
        assert!(!near_token_match("target", "payment"));
    }

    #[test]
    fn related_prefix_token_match_accepts_longer_canonical_label_prefix() {
        assert!(related_prefix_token_match("acmew", "acmealpha"));
    }

    #[test]
    fn related_prefix_token_match_rejects_short_or_unrelated_prefixes() {
        assert!(!related_prefix_token_match("acme", "acmealpha"));
        assert!(!related_prefix_token_match("acmew", "betalpha"));
        assert!(!related_prefix_token_match("acmealpha", "acmew"));
    }

    #[test]
    fn token_sequence_exact_or_contains_rejects_embedded_short_labels() {
        assert!(token_sequence_exact_or_contains("Project Omega", "Omega", 3));
        assert!(token_sequence_exact_or_contains("Project Omega", "Project Omega", 3));
        assert!(!token_sequence_exact_or_contains("Sasha Otoya", "OTO", 3));
    }

    #[test]
    fn normalized_tokens_use_unicode_compatibility_case_folding() {
        assert_eq!(
            normalized_alnum_token_sequence("ＣＡＦÉ ΔELTA alpha-beta", 3),
            vec!["café".to_string(), "δelta".to_string(), "alpha".to_string(), "beta".to_string()]
        );
    }

    #[test]
    fn related_overlap_prefers_exact_rare_token_over_near_name_noise() {
        let candidates =
            build_related_token_candidates(["Omega Delta", "Alphb Person", "Alpha Team"], 3);
        let selection =
            select_related_overlap_tokens_from_candidates("Alpha Omega", &candidates, 3);
        assert!(selection.matches_tokens(&normalized_alnum_tokens("Omega Delta", 3)));
        assert!(!selection.matches_tokens(&normalized_alnum_tokens("Alphb Person", 3)));
        assert!(!selection.matches_tokens(&normalized_alnum_tokens("Alpha Team", 3)));
    }

    #[test]
    fn related_overlap_candidates_exclude_short_token_labels() {
        let labels = ["Omega Delta", "Alphb Person", "Alpha Team", "AI"];
        let candidates = build_related_token_candidates(labels, 3);
        assert_eq!(candidates.len(), 3);

        let selection =
            select_related_overlap_tokens_from_candidates("Alpha Omega", &candidates, 3);

        assert!(selection.matches_tokens(&normalized_alnum_tokens("Omega Delta", 3)));
    }

    #[test]
    fn related_overlap_preserves_candidate_label_multiplicity() {
        let candidates =
            build_related_token_candidates(["Omega Delta", "Omega Delta", "Alpha Team"], 3);
        let selection =
            select_related_overlap_tokens_from_candidates("Alpha Omega", &candidates, 3);

        assert!(selection.matches_tokens(&normalized_alnum_tokens("Alpha Team", 3)));
        assert!(!selection.matches_tokens(&normalized_alnum_tokens("Omega Delta", 3)));
    }

    #[test]
    fn related_overlap_allows_near_match_when_no_exact_token_candidate_exists() {
        let candidates = build_related_token_candidates(["Omega Delta"], 3);
        let selection = select_related_overlap_tokens_from_candidates("Omegax", &candidates, 3);
        assert!(selection.matches_tokens(&normalized_alnum_tokens("Omega Delta", 3)));
    }

    #[test]
    fn related_overlap_allows_prefix_match_when_no_exact_or_near_candidate_exists() {
        let candidates = build_related_token_candidates(["Acmealpha Gateway", "Beta Gateway"], 3);
        let selection = select_related_overlap_tokens_from_candidates("Acmew", &candidates, 3);

        assert!(selection.matches_tokens(&normalized_alnum_tokens("Acmealpha Gateway", 3)));
        assert!(!selection.matches_tokens(&normalized_alnum_tokens("Beta Gateway", 3)));
    }

    #[test]
    fn related_overlap_rejects_ambiguous_prefix_candidates() {
        let candidates =
            build_related_token_candidates(["Acmealpha Gateway", "Acmebeta Gateway"], 3);
        let selection = select_related_overlap_tokens_from_candidates("Acmew", &candidates, 3);

        assert!(selection.is_empty());
    }

    #[test]
    fn related_overlap_allows_nested_prefix_family_candidates() {
        let candidates = build_related_token_candidates(
            ["Acmealpha Gateway", "Acmealphaextra Gateway", "Beta Gateway"],
            3,
        );
        let selection = select_related_overlap_tokens_from_candidates("Acmew", &candidates, 3);

        assert!(selection.matches_tokens(&normalized_alnum_tokens("Acmealpha Gateway", 3)));
        assert!(selection.matches_tokens(&normalized_alnum_tokens("Acmealphaextra Gateway", 3)));
        assert!(!selection.matches_tokens(&normalized_alnum_tokens("Beta Gateway", 3)));
    }

    #[test]
    fn related_overlap_allows_repeated_same_prefix_canonical_token() {
        let candidates = build_related_token_candidates(
            ["Acmealpha Gateway", "Acmealpha Integration", "Beta Gateway"],
            3,
        );
        let selection = select_related_overlap_tokens_from_candidates("Acmew", &candidates, 3);

        assert!(selection.matches_tokens(&normalized_alnum_tokens("Acmealpha Gateway", 3)));
        assert!(selection.matches_tokens(&normalized_alnum_tokens("Acmealpha Integration", 3)));
        assert!(!selection.matches_tokens(&normalized_alnum_tokens("Beta Gateway", 3)));
    }

    #[test]
    fn related_overlap_rejects_short_prefix_target_tokens() {
        let candidates = build_related_token_candidates(["Acmealpha Gateway"], 3);
        let selection = select_related_overlap_tokens_from_candidates("Acme", &candidates, 3);

        assert!(selection.is_empty());
    }
}
