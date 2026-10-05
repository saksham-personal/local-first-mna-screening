import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Compass, Database, Sparkles } from "lucide-react";
import type { ArtifactAction, ChatArtifact, ChatState, ResearchStep } from "../lib/chat-contract";
import { nextStepOptions, nextStepRecommendations } from "../lib/chat-policy";
import "./shortlist-flow.css";

type Props = {
  artifact: Extract<ChatArtifact, { type: "options" }>;
  context?: ChatState;
  onAction: (action: ArtifactAction) => void;
};

const researchIds: ResearchStep[] = ["llm", "copilot", "bing"];

export default function NextStepsCard({ artifact, context, onAction }: Props) {
  const recommendation = context
    ? nextStepRecommendations(context)
    : {
        count: artifact.companyCount ?? 0,
        pb: false,
        rogo: false,
        bing: false,
        hydrated: artifact.hydrated ?? false,
        recommended: Array.isArray(artifact.recommended) ? artifact.recommended : [artifact.recommended],
        researchOpen: (artifact.companyCount ?? 0) > 0,
        uploadsOpen: !(artifact.hydrated ?? false),
      };
  const ruleKey = `${recommendation.count}:${recommendation.hydrated}:${recommendation.recommended.join(",")}`;
  const appliedRule = useRef(ruleKey);
  const [open, setOpen] = useState({ enrichment: recommendation.uploadsOpen, research: recommendation.researchOpen });
  useEffect(() => {
    if (appliedRule.current === ruleKey) return;
    appliedRule.current = ruleKey;
    setOpen({ enrichment: recommendation.uploadsOpen, research: recommendation.researchOpen });
  }, [recommendation.researchOpen, recommendation.uploadsOpen, ruleKey]);

  const recommended = new Set<ResearchStep>(recommendation.recommended);
  const options = artifact.options.length ? artifact.options : nextStepOptions;
  const enrichmentOptions = options.filter((option) => option.id === "pitchbook" || option.id === "rogo");
  const researchOptions = options.filter((option) => researchIds.includes(option.id));
  const count = recommendation.count;
  const hydration = [recommendation.pb && "PitchBook", recommendation.rogo && "ROGO", recommendation.bing && "Bing"].filter(Boolean);
  const choose = (option: ResearchStep) => onAction({ type: "choose-option", artifactId: artifact.id, option });

  if (artifact.dismissed) return <p className="sf-muted">Next steps are deferred. Ask for recommendations whenever you’re ready.</p>;

  const optionButton = (option: (typeof options)[number]) => <button className={`sf-option${recommended.has(option.id) ? " is-recommended" : ""}`} type="button" key={option.id} disabled={!option.available} onClick={() => choose(option.id)}>
    <span className="sf-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
    <span className="sf-option-end">{recommended.has(option.id) && <span className="sf-badge"><Sparkles size={11} /> Recommended</span>}<ArrowRight size={15} aria-hidden="true" /></span>
  </button>;

  return <section className="sf-card" aria-label="Recommended next steps">
    <div className="sf-summary"><span className="sf-summary-icon"><Compass size={17} /></span><div><strong>{count.toLocaleString()} {count === 1 ? "company" : "companies"} in your shortlist</strong><small>{hydration.length ? `Context available from ${hydration.join(", ")}` : "No enrichment data loaded yet"}</small></div></div>
    <div className="sf-accordion">
      <section className="sf-group">
        <button className="sf-group-toggle" type="button" aria-expanded={open.enrichment} onClick={() => setOpen((current) => ({ ...current, enrichment: !current.enrichment }))}>
          <span className="sf-group-icon"><Database size={15} /></span><span><strong>Company enrichment</strong><small>Add source files for company context</small></span><ChevronDown size={15} className={open.enrichment ? "is-open" : ""} />
        </button>
        {open.enrichment && <div className="sf-options">{enrichmentOptions.map(optionButton)}</div>}
      </section>
      <section className="sf-group">
        <button className="sf-group-toggle" type="button" aria-expanded={open.research} onClick={() => setOpen((current) => ({ ...current, research: !current.research }))}>
          <span className="sf-group-icon"><Sparkles size={15} /></span><span><strong>Research and screening</strong><small>Run provider screening or web research</small></span><ChevronDown size={15} className={open.research ? "is-open" : ""} />
        </button>
        {open.research && <div className="sf-options">{researchOptions.map(optionButton)}</div>}
      </section>
    </div>
  </section>;
}
