import { DropdownMenu } from "radix-ui";
import { ChevronDown, ListChecks, MessageSquare } from "lucide-react";
import type {
  ScreeningMode,
  ScreeningProvider,
} from "../lib/screening-contract";
import "./screening-setup.css";
export default function PrepareMenu({
  hasCompanies,
  onChoose,
}: {
  hasCompanies: boolean;
  onChoose: (provider: ScreeningProvider, mode: ScreeningMode) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="ct-log-button"
        aria-label="Prepare screening or a question"
      >
        <ListChecks size={15} />
        <span>Screen / ask</span>
        <ChevronDown size={12} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ss-prepare-menu"
          sideOffset={8}
          align="end"
        >
          <DropdownMenu.Label>Prepare with</DropdownMenu.Label>
          {(["llm_suite", "copilot"] as ScreeningProvider[]).map((provider) => (
            <div key={provider}>
              <DropdownMenu.Item
                onSelect={() => onChoose(provider, "screening")}
                disabled={!hasCompanies}
              >
                <ListChecks size={14} />
                <span>
                  {provider === "llm_suite" ? "LLMSuite" : "M365 Copilot"}{" "}
                  screening
                </span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => onChoose(provider, "question")}
              >
                <MessageSquare size={14} />
                <span>
                  Ask {provider === "llm_suite" ? "LLMSuite" : "M365 Copilot"}
                </span>
              </DropdownMenu.Item>
            </div>
          ))}
          <DropdownMenu.Separator />
          <small>Review and save a setup. Providers are not connected.</small>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
