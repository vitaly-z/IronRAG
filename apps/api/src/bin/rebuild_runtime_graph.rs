use anyhow::Context;
use ironrag_backend::{
    app::{config::Settings, state::AppState},
    infra::repositories::catalog_repository,
    services::graph::error::GraphServiceError,
};
use tracing::{info, warn};
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let settings = Settings::from_env()?;
    ironrag_backend::observability::init_tracing()?;
    let state = AppState::new(settings).await?;

    let mut args = std::env::args().skip(1);
    let target_library_id = args.next().map(|value| Uuid::parse_str(&value)).transpose()?;

    let batch_mode = target_library_id.is_none();
    let libraries = match target_library_id {
        Some(library_id) => catalog_repository::list_libraries(&state.persistence.postgres, None)
            .await?
            .into_iter()
            .filter(|library| library.id == library_id)
            .collect::<Vec<_>>(),
        None => catalog_repository::list_libraries(&state.persistence.postgres, None).await?,
    };

    if libraries.is_empty() {
        anyhow::bail!("no libraries matched rebuild target");
    }

    let mut conflict_count = 0usize;
    for library in libraries {
        info!(
            library_id = %library.id,
            workspace_id = %library.workspace_id,
            library_name = %library.display_name,
            "rebuilding runtime graph"
        );
        let outcome =
            match state.canonical_services.graph.rebuild_library_graph(&state, library.id).await {
                Ok(outcome) => outcome,
                Err(GraphServiceError::StateConflict { message }) if batch_mode => {
                    conflict_count = conflict_count.saturating_add(1);
                    warn!(
                        library_id = %library.id,
                        message = %message,
                        "runtime graph rebuild skipped library because graph state is inconsistent"
                    );
                    continue;
                }
                Err(error) => {
                    return Err(anyhow::Error::new(error)).with_context(|| {
                        format!("failed to rebuild graph for library {}", library.id)
                    });
                }
            };
        info!(
            library_id = %library.id,
            projection_version = outcome.projection_version,
            node_count = outcome.node_count,
            edge_count = outcome.edge_count,
            "runtime graph rebuild completed",
        );
    }

    if conflict_count > 0 {
        anyhow::bail!(
            "runtime graph rebuild skipped {conflict_count} libraries because graph source material was inconsistent"
        );
    }

    ironrag_backend::observability::shutdown_tracing().await;
    Ok(())
}
