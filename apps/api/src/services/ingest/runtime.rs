use anyhow::Context;
use uuid::Uuid;

use crate::{
    agent_runtime::task::RuntimeTaskSpec,
    app::state::AppState,
    domains::{
        agent_runtime::RuntimeOverrideBudget,
        ai::AiBindingPurpose,
        provider_profiles::{EffectiveProviderProfile, ProviderModelSelection},
    },
    services::ingest::error::IngestServiceError,
};

#[derive(Debug, Clone)]
pub struct RuntimeTaskExecutionContext {
    pub provider_profile: EffectiveProviderProfile,
    pub runtime_overrides: RuntimeOverrideBudget,
}

fn binding_purpose_label(binding_purpose: AiBindingPurpose) -> &'static str {
    binding_purpose.as_str()
}

async fn resolve_library_binding_selection(
    state: &AppState,
    library_id: Uuid,
    binding_purpose: AiBindingPurpose,
) -> anyhow::Result<ProviderModelSelection> {
    let binding_label = binding_purpose_label(binding_purpose);
    let binding = state
        .canonical_services
        .ai_catalog
        .resolve_active_runtime_binding(state, library_id, binding_purpose)
        .await
        .with_context(|| format!("failed to resolve active {binding_label} binding"))?
        .with_context(|| {
            format!("active {binding_label} binding is not configured for library {library_id}")
        })?;
    Ok(ProviderModelSelection {
        provider_kind: binding.provider_kind,
        model_name: binding.model_name,
    })
}

async fn resolve_optional_library_binding_selection(
    state: &AppState,
    library_id: Uuid,
    binding_purpose: AiBindingPurpose,
) -> anyhow::Result<Option<ProviderModelSelection>> {
    let binding_label = binding_purpose_label(binding_purpose);
    let Some(binding) = state
        .canonical_services
        .ai_catalog
        .resolve_active_runtime_binding(state, library_id, binding_purpose)
        .await
        .with_context(|| format!("failed to resolve active {binding_label} binding"))?
    else {
        return Ok(None);
    };
    Ok(Some(ProviderModelSelection {
        provider_kind: binding.provider_kind,
        model_name: binding.model_name,
    }))
}

pub async fn resolve_effective_provider_profile(
    state: &AppState,
    library_id: Uuid,
) -> Result<EffectiveProviderProfile, IngestServiceError> {
    // Required bindings block ingest / query flow: ExtractGraph,
    // EmbedChunk, QueryRetrieve, QueryCompile, QueryAnswer. Vision is
    // optional because it only fires on multimodal ingest paths; text-only
    // libraries and local setups without a vision-capable model must keep
    // working.
    Ok(EffectiveProviderProfile {
        indexing: resolve_library_binding_selection(
            state,
            library_id,
            AiBindingPurpose::ExtractGraph,
        )
        .await?,
        embedding: resolve_library_binding_selection(
            state,
            library_id,
            AiBindingPurpose::EmbedChunk,
        )
        .await?,
        query_retrieve: resolve_library_binding_selection(
            state,
            library_id,
            AiBindingPurpose::QueryRetrieve,
        )
        .await?,
        query_compile: resolve_library_binding_selection(
            state,
            library_id,
            AiBindingPurpose::QueryCompile,
        )
        .await?,
        answer: resolve_library_binding_selection(state, library_id, AiBindingPurpose::QueryAnswer)
            .await?,
        vision: resolve_optional_library_binding_selection(
            state,
            library_id,
            AiBindingPurpose::Vision,
        )
        .await?,
    })
}

#[must_use]
pub fn bounded_runtime_overrides(
    state: &AppState,
    task_spec: &RuntimeTaskSpec,
) -> RuntimeOverrideBudget {
    RuntimeOverrideBudget {
        max_turns: Some(state.agent_runtime_settings.max_turns.min(task_spec.max_turns)),
        max_parallel_actions: Some(
            state.agent_runtime_settings.max_parallel_actions.min(task_spec.max_parallel_actions),
        ),
    }
}

pub async fn resolve_effective_runtime_task_context(
    state: &AppState,
    library_id: Uuid,
    task_spec: &RuntimeTaskSpec,
) -> Result<RuntimeTaskExecutionContext, IngestServiceError> {
    Ok(RuntimeTaskExecutionContext {
        provider_profile: resolve_effective_provider_profile(state, library_id).await?,
        runtime_overrides: bounded_runtime_overrides(state, task_spec),
    })
}
