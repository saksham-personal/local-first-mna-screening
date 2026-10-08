import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { LoaderCircle, X } from "lucide-react";
import ScreeningSetup from "./ScreeningSetup";
import { generateDraft } from "../lib/conversation-client";
import { approved } from "../lib/chat-store";
import { getChatState } from "../lib/chat-store";
import {
  getScreeningCatalog,
  previewScreening,
  approveScreening,
  hydrateScreeningSources,
  fetchScreeningPrompt,
  splitExamples,
  listSetupBuilds,
  getSetupBuild,
  type SetupBuild,
} from "../lib/screening-client";
import type {
  ScreeningCatalog,
  ScreeningConfig,
  ScreeningMode,
  ScreeningProvider,
  PreparedScreening,
} from "../lib/screening-contract";

export default function SetupController({
  sessionId,
  provider,
  mode,
  request,
  initialConfig,
  buildId,
  onClose,
  onSaved,
}: {
  sessionId: string;
  provider: ScreeningProvider;
  mode: ScreeningMode;
  request?: string;
  initialConfig?: ScreeningConfig;
  buildId?: string;
  onClose: () => void;
  onSaved: (prepared: PreparedScreening) => void;
}) {
  const initial = useRef(getChatState(sessionId)).current;
  const [catalog, setCatalog] = useState<ScreeningCatalog>();
  const [build, setBuild] = useState<SetupBuild>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void Promise.all([getScreeningCatalog(sessionId, initial.backendRunId), listSetupBuilds()])
      .then(([data, builds]) => {
        if (active) {
          setBuild(builds.filter(job => (!buildId || job.id === buildId) && job.sessionId === sessionId && job.runId === initial.backendRunId && job.provider === provider && job.config.mode === mode && job.status !== "approved").at(-1));
          setCatalog(data);
        }
      })
      .catch((error) => {
        if (active) setError(String(error.message ?? error));
      });
    return () => {
      active = false;
    };
  }, [sessionId, initial.backendRunId, attempt, buildId]);
  useEffect(() => {
    if (!build || (build.status !== "building" && !(build.status === "ready" && !build.catalog))) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void getSetupBuild(sessionId, build.id).then(job => { if (active) { setBuild(job); if (job.catalog) setCatalog(job.catalog); } })
        .catch(error => { if (active) setBuild({ ...build, status: "error", error: String(error.message ?? error) }); });
    }, 1000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [sessionId, build]);
  const guard = () => {
    const current = getChatState(sessionId);
    if (
      current.backendRunId !== initial.backendRunId ||
      current.revision !== initial.revision || !approved(current)
    )
      throw new Error(
        "The screening changed while this setup was open. Close it and reopen the latest setup.",
      );
  };
  if (!catalog)
    return (
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="ss-overlay" />
          <Dialog.Content className="ss-dialog ss-loading-dialog">
            <Dialog.Title>Prepare screening</Dialog.Title>
            <Dialog.Description>
              Read company data and available source columns.
            </Dialog.Description>
            <Dialog.Close className="ct-icon-button" aria-label="Close setup">
              <X size={18} />
            </Dialog.Close>
            {error ? (
              <>
                <p role="alert" className="ct-error-copy">
                  {error}
                </p>
                <button
                  type="button"
                  className="ct-solid-button"
                  onClick={() => setAttempt((x) => x + 1)}
                >
                  Try again
                </button>
              </>
            ) : (
              <p role="status">
                <LoaderCircle size={16} className="ca-spin" /> Reading available
                data…
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <ScreeningSetup
      provider={provider}
      initialMode={mode}
      initialPrompt={request}
      initialConfig={build?.config ?? initialConfig}
      build={build}
      onInvalidateBuild={() => setBuild(undefined)}
      catalog={catalog}
      criteriaText={initial.definition}
      onClose={onClose}
      onBuildPrompt={async (config) => {
        guard();
        const result = await fetchScreeningPrompt({
          sessionId,
          mode: config.mode,
          definition: initial.definition,
          goodFits: splitExamples(initial.goodFitExamples),
          badFits: splitExamples(initial.badFitExamples),
          deferred: initial.ignored,
          inputColumns: config.inputColumns,
          outputColumns: config.outputColumns,
          request: config.request ?? "",
        });
        return result.prompt;
      }}
      onGeneratePrompt={async (config) => {
        guard();
        return generateDraft(sessionId, "screening-prompt", { request: config.request?.trim() || request || config.prompt, outputColumns: config.outputColumns });
      }}
      onPreview={async (config) => {
        guard();
        const job = await previewScreening(sessionId, initial.backendRunId, config);
        setBuild(job);
        return job.preview;
      }}
      onApprove={async (config, preview) => {
        guard();
        const prepared = await approveScreening(
          sessionId,
          initial.backendRunId,
          config,
          preview,
        );
        onSaved(prepared);
        return prepared;
      }}
      onHydrate={async (files, source) => {
        guard();
        if (!initial.backendRunId)
          throw new Error(
            "Find and save companies before adding enrichment files.",
          );
        if (source !== "PB" && source !== "ROGO")
          throw new Error("Choose PitchBook data or ROGO data before importing files.");
        await hydrateScreeningSources(sessionId, initial.backendRunId, files, source === "PB" ? "pitchbook" : "rogo");
        setCatalog(await getScreeningCatalog(sessionId, initial.backendRunId));
      }}
    />
  );
}
