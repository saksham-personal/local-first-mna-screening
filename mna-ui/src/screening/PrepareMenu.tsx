import { DropdownMenu } from "radix-ui";
import { ChevronDown, ListChecks, Search } from "lucide-react";
import type {
  ScreeningMode,
  ScreeningProvider,
} from "../lib/screening-contract";
import "./screening-setup.css";

const providers: { id: ScreeningProvider; name: string }[] = [
  { id: "llm_suite", name: "LLM Suite" },
  { id: "copilot", name: "M365 Copilot" },
];

export default function PrepareMenu({
  hasCompanies,
  onChoose,
  onResearch,
}: {
  hasCompanies: boolean;
  onResearch?: () => void;
  onChoose: (provider: ScreeningProvider, mode: ScreeningMode) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="ct-log-button"
        aria-label="Prepare screening"
      >
        <ListChecks size={15} />
        <span>Screen</span>
        <ChevronDown size={12} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ss-prepare-menu"
          sideOffset={8}
          align="end"
        >
          <DropdownMenu.Label className="ss-prepare-label">
            Prepare with
          </DropdownMenu.Label>
          {providers.map(({ id, name }) => (
            <DropdownMenu.Item
              key={id}
              onSelect={() => onChoose(id, "screening")}
              disabled={!hasCompanies}
            >
              <ListChecks size={14} />
              <span>{name} screening</span>
            </DropdownMenu.Item>
          ))}
          {onResearch && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={onResearch}>
                <Search size={14} />
                <span>Bing research</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
