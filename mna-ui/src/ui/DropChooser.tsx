import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, FileText, MessageSquare, X } from "lucide-react";
import { dropTargets, inPlaceDropSelector, routeDrop, type DropPurpose } from "./drop-zones";
import "./drop-chooser.css";

type Props = {
  onChatFiles: (files: File[]) => void;
  onSourceFiles: (files: File[], purpose: "pitchbook" | "rogo") => void;
  onIntakeFiles?: (files: File[]) => void;
};
export default function DropChooser({ onChatFiles, onSourceFiles, onIntakeFiles }: Props) {
  const [visible, setVisible] = useState(false);
  const cancelled = useRef(false);
  const callbacks = useRef({ onChatFiles, onSourceFiles, onIntakeFiles });
  callbacks.current = { onChatFiles, onSourceFiles, onIntakeFiles };
  useEffect(() => {
    let active = false;
    const files = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const targetElement = (event: DragEvent) => event.target instanceof Element ? event.target : null;
    const drag = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault();
      if (!active) { active = true; cancelled.current = false; }
      const inPlace = targetElement(event)?.closest(inPlaceDropSelector);
      setVisible(!inPlace && !cancelled.current);
    };
    const leave = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault();
      if (!event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) { setVisible(false); active = false; cancelled.current = false; }
    };
    const drop = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault();
      setVisible(false);
      const wasCancelled = cancelled.current;
      cancelled.current = false;
      active = false;
      const target = targetElement(event);
      // Other local zones own their handlers. The composer is routed here so it
      // has priority without changing assistant-ui's message rendering.
      if (target?.closest(".ct-composer-wrap")) {
        event.stopPropagation();
        callbacks.current.onChatFiles(Array.from(event.dataTransfer!.files));
        return;
      }
      if (target?.closest("[data-file-drop-zone]")) return;
      event.stopPropagation();
      const purpose = wasCancelled ? undefined : routeDrop(target?.closest("[data-drop-purpose]")?.getAttribute("data-drop-purpose"));
      if (!purpose) return;
      const incoming = Array.from(event.dataTransfer!.files);
      if (purpose === "chat") callbacks.current.onChatFiles(incoming);
      else if (purpose === "intake") (callbacks.current.onIntakeFiles ?? callbacks.current.onChatFiles)(incoming);
      else callbacks.current.onSourceFiles(incoming, purpose);
    };
    const escape = (event: KeyboardEvent) => {
      if (active && event.key === "Escape") { cancelled.current = true; setVisible(false); }
    };
    window.addEventListener("dragenter", drag, true);
    window.addEventListener("dragover", drag, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("dragenter", drag, true);
      window.removeEventListener("dragover", drag, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  if (!visible) return null;
  const icon = (purpose: DropPurpose) => purpose === "chat" ? <MessageSquare size={24} /> : purpose === "intake" ? <FileText size={24} /> : <FileSpreadsheet size={24} />;
  return <div className="drop-chooser"><section className="drop-chooser-panel" aria-label="File destinations">
    <header><h2>Drop to…</h2><button type="button" aria-label="Cancel file drop" onClick={() => { cancelled.current = true; setVisible(false); }}><X size={18} /></button></header>
    <div className="drop-chooser-targets">{dropTargets.map(target => <div key={target.purpose} className="drop-chooser-tile" data-drop-purpose={target.purpose}>{icon(target.purpose)}<strong>{target.label}</strong><span>{target.hint}</span></div>)}</div>
    <p>Drop outside a tile to cancel. Local upload zones also accept files.</p>
  </section></div>;
}
