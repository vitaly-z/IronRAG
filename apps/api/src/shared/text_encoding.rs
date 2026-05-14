#[must_use]
pub fn repair_utf8_latin1_mojibake(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }

    let mut repaired = String::with_capacity(value.len());
    let mut latin1_span = String::new();
    for character in value.chars() {
        if u32::from(character) <= 0xff {
            latin1_span.push(character);
        } else {
            push_repaired_latin1_span(&mut repaired, &latin1_span);
            latin1_span.clear();
            repaired.push(character);
        }
    }
    push_repaired_latin1_span(&mut repaired, &latin1_span);
    repaired
}

#[must_use]
pub fn repair_json_string_values(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => {
            serde_json::Value::String(repair_utf8_latin1_mojibake(&text))
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items.into_iter().map(repair_json_string_values).collect::<Vec<_>>(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, repair_json_string_values(value)))
                .collect(),
        ),
        other => other,
    }
}

#[must_use]
pub fn escape_json_transport_non_ascii(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii() {
            escaped.push(character);
            continue;
        }
        let mut units = [0u16; 2];
        for unit in character.encode_utf16(&mut units) {
            use std::fmt::Write as _;
            let _ = write!(escaped, "\\u{unit:04x}");
        }
    }
    escaped
}

#[must_use]
pub fn json_contains_repairable_utf8_latin1_mojibake(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(text) => contains_repairable_utf8_latin1_mojibake(text),
        serde_json::Value::Array(items) => {
            items.iter().any(json_contains_repairable_utf8_latin1_mojibake)
        }
        serde_json::Value::Object(values) => {
            values.values().any(json_contains_repairable_utf8_latin1_mojibake)
        }
        _ => false,
    }
}

#[must_use]
pub fn contains_disallowed_controls(value: &str) -> bool {
    value.chars().any(|character| {
        let codepoint = u32::from(character);
        (codepoint < 0x20 && !matches!(character, '\t' | '\n' | '\r'))
            || (0x80..=0x9f).contains(&codepoint)
    })
}

#[must_use]
pub fn contains_repairable_utf8_latin1_mojibake(value: &str) -> bool {
    let mut latin1_span = String::new();
    for character in value.chars() {
        if u32::from(character) <= 0xff {
            latin1_span.push(character);
        } else {
            if would_repair_latin1_span(&latin1_span) {
                return true;
            }
            latin1_span.clear();
        }
    }
    would_repair_latin1_span(&latin1_span)
}

fn push_repaired_latin1_span(output: &mut String, span: &str) {
    if span.is_empty() {
        return;
    }
    let current_score = mojibake_signal_score(span);
    if current_score == 0 {
        output.push_str(span);
        return;
    }

    let bytes = span.chars().map(|character| character as u8).collect::<Vec<_>>();
    match String::from_utf8(bytes) {
        Ok(candidate)
            if !contains_disallowed_controls(&candidate)
                && latin1_repair_is_unambiguous(span, &candidate)
                && mojibake_signal_score(&candidate) < current_score =>
        {
            output.push_str(&candidate);
        }
        _ => output.push_str(span),
    }
}

fn would_repair_latin1_span(span: &str) -> bool {
    if span.is_empty() || mojibake_signal_score(span) == 0 {
        return false;
    }
    let bytes = span.chars().map(|character| character as u8).collect::<Vec<_>>();
    match String::from_utf8(bytes) {
        Ok(candidate) => {
            !contains_disallowed_controls(&candidate)
                && latin1_repair_is_unambiguous(span, &candidate)
                && mojibake_signal_score(&candidate) < mojibake_signal_score(span)
        }
        Err(_) => false,
    }
}

fn latin1_repair_is_unambiguous(original: &str, candidate: &str) -> bool {
    contains_disallowed_controls(original)
        || original.chars().any(|character| character == '\u{fffd}')
        || candidate.chars().any(|character| u32::from(character) > 0xff)
}

fn mojibake_signal_score(value: &str) -> usize {
    let mut score = 0usize;
    let mut previous = None;
    for character in value.chars() {
        let codepoint = u32::from(character);
        if codepoint == 0xfffd {
            score = score.saturating_add(8);
        }
        if (0x80..=0x9f).contains(&codepoint) {
            score = score.saturating_add(8);
        }
        if previous
            .is_some_and(|lead| (0xc2..=0xf4).contains(&lead) && (0x80..=0xbf).contains(&codepoint))
        {
            score = score.saturating_add(4);
        }
        previous = Some(codepoint);
    }
    score
}

#[cfg(test)]
mod tests {
    use super::{
        contains_repairable_utf8_latin1_mojibake, escape_json_transport_non_ascii,
        repair_json_string_values, repair_utf8_latin1_mojibake,
    };

    #[test]
    fn repairs_live_utf8_latin1_mojibake_span() {
        let mojibake = "\u{00d0}\u{009f}\u{00d0}\u{00b0}\u{00d1}\u{0080}\u{00d0}\u{00b0}\u{00d0}\u{00bc}\u{00d0}\u{00b5}\u{00d1}\u{0082}\u{00d1}\u{0080}\u{00d1}\u{008b} SoftPhone";

        assert!(contains_repairable_utf8_latin1_mojibake(mojibake));
        assert_eq!(repair_utf8_latin1_mojibake(mojibake), "Параметры SoftPhone");
    }

    #[test]
    fn repairs_nested_json_string_values_without_trimming() {
        let repaired = repair_json_string_values(serde_json::json!({
            "entities": [
                {
                    "label": "\u{00d0}\u{009f}\u{00d0}\u{00b0}\u{00d1}\u{0080}\u{00d0}\u{00b0}\u{00d0}\u{00bc}\u{00d0}\u{00b5}\u{00d1}\u{0082}\u{00d1}\u{0080}\u{00d1}\u{008b} SoftPhone",
                    "summary": " \u{00d0}\u{0097}\u{00d0}\u{00b2}\u{00d0}\u{00be}\u{00d0}\u{00bd}\u{00d0}\u{00be}\u{00d0}\u{00ba} "
                }
            ]
        }));

        assert_eq!(repaired["entities"][0]["label"], "Параметры SoftPhone");
        assert_eq!(repaired["entities"][0]["summary"], " Звонок ");
    }

    #[test]
    fn repairs_ascii_prefixed_dash_and_text_mojibake() {
        let mojibake = "ExampleTool \u{00e2}\u{0080}\u{0094} \u{00d0}\u{00a1}\u{00d0}\u{00b8}\u{00d0}\u{00bd}\u{00d1}\u{0082}\u{00d0}\u{00b5}\u{00d1}\u{0082}\u{00d0}\u{00b8}\u{00d1}\u{0087}\u{00d0}\u{00b5}\u{00d1}\u{0081}\u{00d0}\u{00ba}\u{00d0}\u{00b0}\u{00d1}\u{008f} \u{00d1}\u{0081}\u{00d1}\u{0082}\u{00d1}\u{0080}\u{00d0}\u{00be}\u{00d0}\u{00ba}\u{00d0}\u{00b0}";

        assert!(contains_repairable_utf8_latin1_mojibake(mojibake));
        assert_eq!(repair_utf8_latin1_mojibake(mojibake), "ExampleTool — Синтетическая строка");
    }

    #[test]
    fn repairs_live_provider_summary_mojibake() {
        let mojibake = "displayName \u{00e2}\u{0080}\u{0094} \u{00d0}\u{00be}\u{00d1}\u{0082}\u{00d0}\u{00be}\u{00d0}\u{00b1}\u{00d1}\u{0080}\u{00d0}\u{00b0}\u{00d0}\u{00b6}\u{00d0}\u{00b0}\u{00d0}\u{00b5}\u{00d0}\u{00bc}\u{00d0}\u{00be}\u{00d0}\u{00b5} \u{00d0}\u{00b8}\u{00d0}\u{00bc}\u{00d1}\u{008f}";

        assert!(contains_repairable_utf8_latin1_mojibake(mojibake));
        assert_eq!(repair_utf8_latin1_mojibake(mojibake), "displayName — отображаемое имя");
    }

    #[test]
    fn repairs_live_mixed_script_label_mojibake() {
        let mojibake = "\u{00d0}\u{00a1}\u{00d0}\u{00be}\u{00d0}\u{00be}\u{00d0}\u{00b1}\u{00d1}\u{0089}\u{00d0}\u{00b5}\u{00d0}\u{00bd}\u{00d0}\u{00b8}\u{00d0}\u{00b5} TransferCallReturned";

        assert!(contains_repairable_utf8_latin1_mojibake(mojibake));
        assert_eq!(repair_utf8_latin1_mojibake(mojibake), "Сообщение TransferCallReturned");
    }

    #[test]
    fn escapes_json_transport_non_ascii_without_touching_structure() {
        let json = r#"{"label":"Строка","dash":"—","plain":"displayName"}"#;

        assert_eq!(
            escape_json_transport_non_ascii(json),
            r#"{"label":"\u0421\u0442\u0440\u043e\u043a\u0430","dash":"\u2014","plain":"displayName"}"#
        );
    }
}
