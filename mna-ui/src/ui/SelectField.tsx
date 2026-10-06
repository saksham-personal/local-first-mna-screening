import { Select } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

type Option = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

/** One themed, keyboard-accessible select for appearance and workspace filters. */
export default function SelectField({
  label,
  value,
  onChange,
  options,
  icon,
  className = "",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  icon?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger
        className={`ui-select-trigger ${className}`}
        aria-label={label}
        title={label}
      >
        {icon && (
          <span className="ui-select-leading" aria-hidden="true">
            {icon}
          </span>
        )}
        <Select.Value />
        <Select.Icon className="ui-select-chevron">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="ui-select-content"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <Select.ScrollUpButton className="ui-select-scroll">
            <ChevronUp size={14} />
          </Select.ScrollUpButton>
          <Select.Viewport className="ui-select-viewport">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={`ui-select-item${option.description ? "" : " ui-select-item-plain"}`}
                textValue={option.label}
              >
                {option.icon && (
                  <span className="ui-select-option-icon" aria-hidden="true">
                    {option.icon}
                  </span>
                )}
                <span className="ui-select-option-copy">
                  <Select.ItemText>{option.label}</Select.ItemText>
                  {option.description && <small>{option.description}</small>}
                </span>
                <Select.ItemIndicator className="ui-select-check">
                  <Check size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="ui-select-scroll">
            <ChevronDown size={14} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
