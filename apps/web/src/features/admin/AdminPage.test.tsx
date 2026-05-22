import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminPage from "@/features/admin/AdminPage";
import { TooltipProvider } from "@/shared/components/ui/tooltip";

const {
  useAppMock,
  adminApiMock,
  dashboardApiMock,
  librarySnapshotApiMock,
  queryApiMock,
  catalogMock,
  opsMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  useAppMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  adminApiMock: {
    listTokens: vi.fn(),
    listWorkspaces: vi.fn(),
    listLibraries: vi.fn(),
    mintToken: vi.fn(),
    revokeToken: vi.fn(),
    deleteToken: vi.fn(),
    listProviders: vi.fn(),
    listModels: vi.fn(),
    listCredentials: vi.fn(),
    listPresets: vi.fn(),
    listBindings: vi.fn(),
    listPrices: vi.fn(),
    createPriceOverride: vi.fn(),
    listAuditEvents: vi.fn(),
    listIngestQueue: vi.fn(),
    moveIngestQueueJob: vi.fn(),
    pauseIngestQueueJob: vi.fn(),
    resumeIngestQueueJob: vi.fn(),
    cancelIngestQueueJob: vi.fn(),
  },
  dashboardApiMock: {
    getLibraryState: vi.fn(),
  },
  librarySnapshotApiMock: {
    export: vi.fn(),
    import: vi.fn(),
    downloadExport: vi.fn(),
  },
  queryApiMock: {
    getAssistantSystemPrompt: vi.fn(),
  },
  catalogMock: {
    deleteCatalogLibrary: vi.fn(),
  },
  opsMock: {
    getAsyncOperation: vi.fn(),
  },
}));

vi.mock("@/shared/contexts/app-context", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
    warning: vi.fn(),
    loading: vi.fn(() => "toast-1"),
  },
}));

vi.mock("@/shared/api", () => ({
  adminApi: adminApiMock,
  dashboardApi: dashboardApiMock,
  librarySnapshotApi: librarySnapshotApiMock,
  queryApi: queryApiMock,
  Catalog: catalogMock,
  Ops: opsMock,
  unwrap: (value: { data?: unknown }) => value.data ?? value,
  ASYNC_OPERATION_TERMINAL_STATES: new Set(["ready", "failed", "canceled", "superseded"]),
  // McpTab + OperationsTab consume the generated TanStack queryOptions
  // instead of queryApi/dashboardApi/adminApi directly. Each stub returns a
  // hand-shaped queryOptions whose queryFn delegates to the existing
  // *Mock fns so the historical assertions keep working without rebuilding
  // the test around the generated SDK classes.
  queries: {
    getAssistantSystemPromptOptions: (
      input?: { query?: { libraryId?: string } } | undefined,
    ) => ({
      queryKey: ["mockedSystemPrompt", input?.query?.libraryId ?? null],
      queryFn: async () =>
        queryApiMock.getAssistantSystemPrompt(input?.query?.libraryId),
    }),
    getLibraryStateOptions: (input: { path: { libraryId: string } }) => ({
      queryKey: ["mockedLibraryState", input.path.libraryId],
      queryFn: async () =>
        dashboardApiMock.getLibraryState(input.path.libraryId),
    }),
    listAuditEventsOptions: (input?: {
      query?: Parameters<typeof adminApiMock.listAuditEvents>[0];
    }) => ({
      queryKey: ["mockedAuditEvents", input?.query ?? null],
      queryFn: async () => adminApiMock.listAuditEvents(input?.query ?? {}),
    }),
    listIngestQueueQueryKey: () => ["mockedIngestQueue"],
    listIngestQueueOptions: () => ({
      queryKey: ["mockedIngestQueue"],
      queryFn: async () => adminApiMock.listIngestQueue(),
    }),
    listIngestStageEventsOptions: (input: { path: { attemptId: string } }) => ({
      queryKey: ["mockedIngestStageEvents", input.path.attemptId],
      queryFn: async () => ({
        attempt: {},
        job: {},
        readiness: { textReady: false, vectorReady: false },
        stages: [
          {
            id: "stage-1",
            attempt_id: input.path.attemptId,
            ordinal: 1,
            stage_name: "extract_content",
            stage_state: "running",
            message: "Reading source",
            details_json: { pages: 3 },
            recorded_at: "2026-05-14T10:01:00Z",
          },
        ],
      }),
    }),
    listAiProvidersOptions: () => ({
      queryKey: ["mockedListAiProviders"],
      queryFn: async () => adminApiMock.listProviders(),
    }),
    listAiPricesOptions: () => ({
      queryKey: ["mockedListAiPrices"],
      queryFn: async () => adminApiMock.listPrices(),
    }),
    listIamTokensOptions: () => ({
      queryKey: ["mockedListIamTokens"],
      queryFn: async () => adminApiMock.listTokens(),
    }),
    listCatalogWorkspacesOptions: () => ({
      queryKey: ["mockedListCatalogWorkspaces"],
      queryFn: async () => adminApiMock.listWorkspaces(),
    }),
    listCatalogLibrariesOptions: (input: {
      path: { workspaceId: string };
    }) => ({
      queryKey: ["mockedListCatalogLibraries", input.path.workspaceId],
      queryFn: async () => adminApiMock.listLibraries(input.path.workspaceId),
    }),
    listCatalogWorkspacesQueryKey: () => ["mockedListCatalogWorkspaces"],
    listCatalogLibrariesQueryKey: (input: { path: { workspaceId: string } }) => [
      "mockedListCatalogLibraries",
      input.path.workspaceId,
    ],
    getWorkspaceCostSummaryOptions: (input: { query: { workspaceId: string } }) => ({
      queryKey: ["mockedWorkspaceCostSummary", input.query.workspaceId],
      queryFn: async () => ({
        totalCost: "1.25",
        currencyCode: "USD",
        libraryCount: 2,
        documentCount: 7,
        providerCallCount: 11,
      }),
    }),
    getWorkspaceCostSummaryQueryKey: (input: { query: { workspaceId: string } }) => [
      "mockedWorkspaceCostSummary",
      input.query.workspaceId,
    ],
    getLibraryCostSummaryOptions: (input: { query: { libraryId: string } }) => ({
      queryKey: ["mockedLibraryCostSummary", input.query.libraryId],
      queryFn: async () => ({
        totalCost: input.query.libraryId === "library-2" ? "0.75" : "0.50",
        currencyCode: "USD",
        documentCount: input.query.libraryId === "library-2" ? 4 : 3,
        providerCallCount: input.query.libraryId === "library-2" ? 6 : 5,
      }),
    }),
    getLibraryCostSummaryQueryKey: (input: { query: { libraryId: string } }) => [
      "mockedLibraryCostSummary",
      input.query.libraryId,
    ],
  },
  adminModelCatalogOptions: (
    params: Parameters<typeof adminApiMock.listModels>[0] = {},
  ) => ({
    queryKey: ["mockedModelCatalog", params],
    queryFn: async () => adminApiMock.listModels(params),
  }),
}));

// AiConfigurationPanel is heavy (937 lines) and not what these integration
// tests are validating — they check tab routing and the orchestrator shell.
vi.mock("@/features/admin/components/AiConfigurationPanel", () => ({
  default: () => <div data-testid="ai-panel">AI panel</div>,
}));

function makeOpsToken(status: "active" | "revoked" = "active") {
  return {
    principalId: "principal-1",
    label: "Ops token",
    tokenPrefix: "irr_abc",
    status,
    revokedAt: status === "revoked" ? "2026-05-14T10:00:00Z" : undefined,
    issuer: {
      principalId: "admin-1",
      displayLabel: "admin",
    },
    scope: {
      kind: "library",
      workspace: { id: "ws-1", displayName: "Workspace 1" },
      libraries: [
        { id: "library-1", workspaceId: "ws-1", displayName: "Library 1" },
      ],
    },
    grants: [
      {
        resourceKind: "library",
        resourceId: "library-1",
        permissionKind: "library_write",
        workspace: { id: "ws-1", displayName: "Workspace 1" },
        library: {
          id: "library-1",
          workspaceId: "ws-1",
          displayName: "Library 1",
        },
      },
      {
        resourceKind: "library",
        resourceId: "library-1",
        permissionKind: "document_read",
        workspace: { id: "ws-1", displayName: "Workspace 1" },
        library: {
          id: "library-1",
          workspaceId: "ws-1",
          displayName: "Library 1",
        },
      },
    ],
  };
}

describe("AdminPage integration", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.setPointerCapture = vi.fn();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;

    useAppMock.mockReturnValue({
      activeWorkspace: { id: "ws-1", name: "Workspace 1" },
      activeLibrary: { id: "library-1", name: "Library 1" },
      workspaces: [
        { id: "ws-1", name: "Workspace 1", createdAt: "2026-05-14T00:00:00Z" },
        { id: "ws-2", name: "Workspace 2", createdAt: "2026-05-14T00:00:00Z" },
      ],
      setActiveWorkspace: vi.fn(),
      setActiveLibrary: vi.fn(),
      selectWorkspaceLibrary: vi.fn(() => true),
      refreshSession: vi.fn(),
      locale: "en",
      setLocale: vi.fn(),
    });

    adminApiMock.listTokens.mockResolvedValue([makeOpsToken()]);
    adminApiMock.listProviders.mockResolvedValue([]);
    adminApiMock.listModels.mockResolvedValue([]);
    adminApiMock.listPrices.mockResolvedValue([]);
    adminApiMock.listAuditEvents.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    adminApiMock.listIngestQueue.mockResolvedValue({
      summary: { running: 1, queued: 2, paused: 1, total: 4 },
      items: [
        {
          jobId: "job-running",
          workspaceId: "ws-1",
          workspaceName: "Workspace 1",
          libraryId: "library-1",
          libraryName: "Library 1",
          documentId: "doc-running",
          documentName: "running.pdf",
          jobKind: "canonical_ingest",
          queueState: "leased",
          attemptState: "running",
          queuedAt: "2026-05-14T10:00:00Z",
          availableAt: "2026-05-14T10:00:00Z",
          attemptId: "attempt-running",
          attemptNumber: 1,
          currentStage: "extract_content",
          progressPercent: 35,
          startedAt: "2026-05-14T10:00:30Z",
          heartbeatAt: "2026-05-14T10:01:00Z",
        },
        {
          jobId: "job-queued",
          workspaceId: "ws-1",
          workspaceName: "Workspace 1",
          libraryId: "library-1",
          libraryName: "Library 1",
          documentId: "doc-queued",
          documentName: "queued.md",
          jobKind: "canonical_ingest",
          queueState: "queued",
          queuePosition: 1,
          queuedAt: "2026-05-14T10:02:00Z",
          availableAt: "2026-05-14T10:02:00Z",
        },
        {
          jobId: "job-paused",
          workspaceId: "ws-1",
          workspaceName: "Workspace 1",
          libraryId: "library-1",
          libraryName: "Library 1",
          documentId: "doc-paused",
          documentName: "paused.txt",
          jobKind: "canonical_ingest",
          queueState: "paused",
          attemptState: "abandoned",
          queuePosition: 2,
          queuedAt: "2026-05-14T10:03:00Z",
          availableAt: "2026-05-14T10:03:00Z",
          attemptId: "attempt-paused",
          attemptNumber: 1,
          currentStage: "chunk_content",
          progressPercent: 45,
          failureCode: "paused_by_operator",
          failureMessage: "Processing was paused from the administration queue",
        },
        {
          jobId: "job-other-workspace",
          workspaceId: "ws-2",
          workspaceName: "Workspace 2",
          libraryId: "library-3",
          libraryName: "Library 3",
          documentId: "doc-other-workspace",
          documentName: "other-workspace.md",
          jobKind: "canonical_ingest",
          queueState: "queued",
          queuePosition: 3,
          queuedAt: "2026-05-14T10:04:00Z",
          availableAt: "2026-05-14T10:04:00Z",
        },
      ],
    });
    adminApiMock.moveIngestQueueJob.mockImplementation(async () =>
      adminApiMock.listIngestQueue(),
    );
    adminApiMock.pauseIngestQueueJob.mockImplementation(async () =>
      adminApiMock.listIngestQueue(),
    );
    adminApiMock.resumeIngestQueueJob.mockImplementation(async () =>
      adminApiMock.listIngestQueue(),
    );
    adminApiMock.cancelIngestQueueJob.mockImplementation(async () =>
      adminApiMock.listIngestQueue(),
    );
    adminApiMock.listWorkspaces.mockResolvedValue([
      { id: "ws-1", slug: "workspace-1", displayName: "Workspace 1", lifecycleState: "active" },
      { id: "ws-2", slug: "workspace-2", displayName: "Workspace 2", lifecycleState: "active" },
    ]);
    adminApiMock.listLibraries.mockImplementation(async (workspaceId: string) =>
      workspaceId === "ws-1"
        ? [
            {
              id: "library-1",
              workspaceId: "ws-1",
              slug: "library-1",
              displayName: "Library 1",
              lifecycleState: "active",
              includeDocumentHintInMcpAnswers: false,
              ingestionReadiness: { ready: true, missingBindingPurposes: [] },
              recognitionPolicy: {},
              webIngestPolicy: {},
            },
            {
              id: "library-2",
              workspaceId: "ws-1",
              slug: "library-2",
              displayName: "Library 2",
              lifecycleState: "active",
              includeDocumentHintInMcpAnswers: false,
              ingestionReadiness: { ready: false, missingBindingPurposes: ["query_answer"] },
              recognitionPolicy: {},
              webIngestPolicy: {},
            },
          ]
        : workspaceId === "ws-2"
          ? [
              {
                id: "library-3",
                workspaceId: "ws-2",
                slug: "library-3",
                displayName: "Library 3",
                lifecycleState: "active",
                includeDocumentHintInMcpAnswers: false,
                ingestionReadiness: { ready: true, missingBindingPurposes: [] },
                recognitionPolicy: {},
                webIngestPolicy: {},
              },
            ]
          : [],
    );
    adminApiMock.mintToken.mockResolvedValue({
      token: "irr_secret",
      apiToken: {
        principalId: "principal-created",
        label: "Created token",
        tokenPrefix: "irr_new",
        status: "active",
        scope: {
          kind: "workspace",
          workspace: { id: "ws-1", displayName: "Workspace 1" },
          libraries: [],
        },
        grants: [
          {
            resourceKind: "workspace",
            resourceId: "ws-1",
            permissionKind: "document_read",
            workspace: { id: "ws-1", displayName: "Workspace 1" },
          },
        ],
      },
    });
    adminApiMock.revokeToken.mockResolvedValue(undefined);
    adminApiMock.deleteToken.mockResolvedValue(undefined);
    dashboardApiMock.getLibraryState.mockResolvedValue({
      state: {
        queueDepth: 0,
        runningAttempts: 0,
        readableDocumentCount: 0,
        failedDocumentCount: 0,
        degradedState: "healthy",
        knowledgeGenerationState: "graph_ready",
        lastRecomputedAt: "2026-04-10T10:00:00Z",
      },
      warnings: [],
    });
    queryApiMock.getAssistantSystemPrompt.mockResolvedValue({
      rendered: "# MCP system prompt",
      template: "# template",
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container.remove();
  });

  async function flushUi() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function renderPage(initialPath = "/admin") {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
      },
    });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter initialEntries={[initialPath]}>
              <AdminPage />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushUi();
    await flushUi();
  }

  /**
   * Radix `TabsTrigger` elements render with `role="tab"` and surface their
   * value via `data-value` / `id="…-trigger-{value}"`. Relying on text
   * substring is fragile when OperationsTab content also contains the word
   * "Operations"; this helper targets the trigger by role + text.
   */
  function findTabTrigger(text: string) {
    return Array.from(container.querySelectorAll('[role="tab"]')).find((el) =>
      el.textContent?.includes(text),
    ) as HTMLButtonElement | undefined;
  }

  it("defaults to the access tab and fetches the token list", async () => {
    await renderPage();

    expect(adminApiMock.listTokens).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Ops token");
    expect(container.textContent).toContain("Workspace 1");
    expect(container.textContent).toContain("Library 1");
    expect(container.textContent).toContain("Library write + import");
  });

  it("opens the operations tab from the URL and fetches ops + audit data", async () => {
    await renderPage("/admin?tab=operations");

    expect(adminApiMock.listTokens).not.toHaveBeenCalled();
    expect(dashboardApiMock.getLibraryState).toHaveBeenCalledWith("library-1");
    expect(adminApiMock.listAuditEvents).toHaveBeenCalled();
  });

  it("opens the libraries tab with cross-workspace summary, filters, table, and inspector", async () => {
    await renderPage("/admin?tab=libraries");

    expect(adminApiMock.listWorkspaces).toHaveBeenCalled();
    expect(adminApiMock.listLibraries).toHaveBeenCalledWith("ws-1");
    expect(container.textContent).toContain("Total cost");
    expect(container.textContent).toContain("Library 1");
    expect(container.textContent).toContain("Library 2");
    expect(container.textContent).toContain("Library inspector");
    expect(container.textContent).toContain("Open documents");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("Blocked");
    expect(container.querySelector('[aria-label^="Calls: Provider calls"]')).toBeTruthy();
    expect(container.querySelector('[aria-label^="Readiness: Whether the library"]')).toBeTruthy();
    expect(container.querySelector('[aria-label^="Lifecycle: Operational state"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Select visible libraries"]')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();

    const callsHeader = container.querySelector<HTMLButtonElement>('[aria-label^="Calls: Provider calls"]');
    expect(callsHeader).toBeTruthy();
    await act(async () => {
      callsHeader?.click();
      callsHeader?.click();
    });
    const firstDataRow = container.querySelector("tbody tr");
    expect(firstDataRow?.textContent).toContain("Library 2");

    const selectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Select",
    );
    expect(selectButton).toBeTruthy();
    await act(async () => {
      selectButton?.click();
    });
    expect(container.querySelector('[aria-label="Select visible libraries"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Select Library 1"]')).toBeTruthy();
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(1);
  });

  it("opens the queue tab, renders active jobs, and shows the running-job inspector", async () => {
    window.localStorage.setItem(
      "ironrag_table_state:admin.ingestQueue",
      JSON.stringify({ pageSize: 1000 }),
    );
    await renderPage("/admin?tab=queue");

    expect(adminApiMock.listIngestQueue).toHaveBeenCalled();
    expect(container.textContent).toContain("running.pdf");
    expect(container.textContent).toContain("queued.md");
    expect(container.textContent).toContain("paused.txt");
    expect(container.textContent).toContain("other-workspace.md");
    expect(container.querySelector('[aria-label="Workspace filter"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Library filter"]')).toBeTruthy();
    expect(container.textContent).toContain("All workspaces (4)");
    expect(container.textContent).toContain("All libraries (4)");
    expect(container.textContent).toContain("Job inspector");
    expect(container.textContent).toContain("extract_content");
    expect(container.textContent).toContain("Reading source");
    expect(container.querySelector('[aria-label="Select visible jobs"]')).toBeNull();

    const pageSizeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "1000",
    );
    expect(pageSizeButton).toBeTruthy();
    expect(document.body.textContent).toContain("1000");

    const selectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Select",
    );
    expect(selectButton).toBeTruthy();
    await act(async () => {
      selectButton?.click();
    });
    expect(container.querySelector('[aria-label="Select visible jobs"]')).toBeTruthy();

    const queuedCheckbox = container.querySelector<HTMLInputElement>(
      '[aria-label="Select queued.md"]',
    );
    expect(queuedCheckbox).toBeTruthy();
    await act(async () => {
      queuedCheckbox?.click();
    });
    expect(container.textContent).toContain("1 job selected");

    const bulkCancelButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Cancel 1",
    );
    expect(bulkCancelButton).toBeTruthy();
    await act(async () => {
      bulkCancelButton?.click();
    });
    await flushUi();
    expect(adminApiMock.cancelIngestQueueJob).toHaveBeenCalledWith("job-queued");
  });

  it("sends queue reorder, pause, and resume commands from the queue tab", async () => {
    await renderPage("/admin?tab=queue");

    const moveDownButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[title="Move down"]',
      ),
    ).find((button) => !button.disabled);
    expect(moveDownButton).toBeTruthy();
    await act(async () => {
      moveDownButton?.click();
    });
    expect(adminApiMock.moveIngestQueueJob).toHaveBeenCalledWith(
      "job-queued",
      "down",
    );

    const pauseButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[title="Pause job"]',
      ),
    ).find((button) => !button.disabled);
    expect(pauseButton).toBeTruthy();
    await act(async () => {
      pauseButton?.click();
    });
    expect(adminApiMock.pauseIngestQueueJob).toHaveBeenCalled();

    const pausedRow = Array.from(container.querySelectorAll("tr")).find((row) =>
      row.textContent?.includes("paused.txt"),
    );
    expect(pausedRow).toBeTruthy();
    await act(async () => {
      pausedRow?.click();
    });
    await flushUi();

    const resumeButton = container.querySelector<HTMLButtonElement>(
      'button[title="Resume job"]',
    );
    expect(resumeButton).toBeTruthy();
    await act(async () => {
      resumeButton?.click();
    });
    expect(adminApiMock.resumeIngestQueueJob).toHaveBeenCalledWith(
      "job-paused",
    );
  });

  it("lazy-loads the pricing catalog only when the pricing tab is the URL target", async () => {
    // Access tab (default) must NOT preload the catalog.
    await renderPage();
    expect(adminApiMock.listProviders).not.toHaveBeenCalled();
    expect(adminApiMock.listModels).not.toHaveBeenCalled();

    // Unmount the access-tab instance so the catalog-loaded ref doesn't
    // survive into the pricing-tab instance and defeat the guard.
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.innerHTML = "";

    await renderPage("/admin?tab=pricing");
    // Landing directly on pricing triggers the catalog fetch exactly once
    // per mount and does NOT re-fire even though the fetched catalog is
    // empty (empty-list regression guard).
    expect(adminApiMock.listProviders).toHaveBeenCalledTimes(1);
    expect(adminApiMock.listModels).toHaveBeenCalledTimes(1);
    expect(adminApiMock.listModels).toHaveBeenCalledWith({});
    expect(adminApiMock.listPrices).toHaveBeenCalled();
  });

  it("opens the MCP tab from the URL and loads the canonical system prompt", async () => {
    await renderPage("/admin?tab=mcp");

    expect(queryApiMock.getAssistantSystemPrompt).toHaveBeenCalledWith(
      "library-1",
    );
    expect(container.textContent).toContain("MCP system prompt");
    expect(container.textContent).toContain("OpenClaw");
    expect(container.textContent).toContain("Hermes");
  });

  it("renders the access tab trigger and the operations tab trigger side by side", async () => {
    await renderPage();

    // Sanity check that the tab list is intact so navigating by clicking
    // stays supported even though the other tests drive via URL.
    expect(findTabTrigger("Access")).toBeTruthy();
    expect(findTabTrigger("Libraries")).toBeTruthy();
    expect(findTabTrigger("Operations")).toBeTruthy();
    expect(findTabTrigger("Queue")).toBeTruthy();
    expect(findTabTrigger("Pricing")).toBeTruthy();
    expect(findTabTrigger("MCP")).toBeTruthy();
  });

  it("optimistically marks a token revoked and rolls back with a toast on failure", async () => {
    let rejectRevoke!: (reason: Error) => void;
    adminApiMock.revokeToken.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRevoke = reject;
      }),
    );

    await renderPage();

    const revokeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Revoke"),
    );
    expect(revokeButton).toBeTruthy();

    await act(async () => {
      revokeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushUi();

    expect(container.textContent).toContain("Ops token");
    expect(container.textContent).toContain("revoked");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Delete"),
      ),
    ).toBe(true);

    await act(async () => {
      rejectRevoke(new Error("revoke unavailable"));
    });
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain("Ops token");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Revoke"),
      ),
    ).toBe(true);
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("revoke unavailable"),
    );
  });

  it("optimistically deletes a revoked token and rolls back with a toast on failure", async () => {
    let rejectDelete!: (reason: Error) => void;
    adminApiMock.listTokens.mockResolvedValue([makeOpsToken("revoked")]);
    adminApiMock.deleteToken.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDelete = reject;
      }),
    );

    await renderPage();

    const openDeleteButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Delete"));
    expect(openDeleteButton).toBeTruthy();

    await act(async () => {
      openDeleteButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushUi();

    const confirmDeleteButton = Array.from(
      document.body.querySelectorAll("button"),
    )
      .filter((button) => button.textContent?.includes("Delete"))
      .at(-1);
    expect(confirmDeleteButton).toBeTruthy();

    await act(async () => {
      confirmDeleteButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushUi();

    expect(container.textContent).not.toContain("Ops token");

    await act(async () => {
      rejectDelete(new Error("delete unavailable"));
    });
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain("Ops token");
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("delete unavailable"),
    );
  });

  it("optimistically inserts a minted token row and rolls back with a toast on failure", async () => {
    let rejectMint!: (reason: Error) => void;
    adminApiMock.mintToken.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectMint = reject;
      }),
    );

    await renderPage();

    const openCreateButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Create Token"));
    expect(openCreateButton).toBeTruthy();

    await act(async () => {
      openCreateButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushUi();

    const labelInput = Array.from(document.body.querySelectorAll("input")).find(
      (input) => input.getAttribute("placeholder") === "Production API",
    );
    expect(labelInput).toBeTruthy();
    const valueDescriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    );
    await act(async () => {
      valueDescriptor?.set?.call(labelInput, "Instant token");
      labelInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushUi();

    const permissionCheckbox = document.getElementById("perm-document_read");
    expect(permissionCheckbox).toBeTruthy();
    await act(async () => {
      permissionCheckbox?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushUi();

    const submitButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Create");
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushUi();

    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Instant token"),
      ),
    ).toBe(true);

    await act(async () => {
      rejectMint(new Error("mint unavailable"));
    });
    await flushUi();
    await flushUi();

    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Instant token"),
      ),
    ).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("mint unavailable"),
    );
  });
});
