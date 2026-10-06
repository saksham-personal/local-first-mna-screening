import type { ReactNode } from "react";
import HelpTip from "./ui/HelpTip";

/** Legacy entry point; new code should import `HelpTip` from `./ui/HelpTip` directly. */
export default function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return <HelpTip label={label}>{children}</HelpTip>;
}
