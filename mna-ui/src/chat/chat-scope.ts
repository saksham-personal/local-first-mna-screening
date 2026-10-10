import { createContext } from "react";
import type { ArtifactAction } from "../lib/chat-contract";

export type Scope = {
  sessionId: string;
  onAction: (action: ArtifactAction) => void | Promise<void>;
  openLog: (eventId?: string) => void;
  openContext: () => void;
  openPrompts: () => void;
  previewFile: (file: File) => void;
};
export const ChatScope = createContext<Scope>({
  sessionId: "",
  onAction: () => {},
  openLog: () => {},
  openContext: () => {},
  openPrompts: () => {},
  previewFile: () => {},
});
