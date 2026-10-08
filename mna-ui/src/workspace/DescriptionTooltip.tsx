import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GridCompany, GridDescription } from "../lib/grid-client";
import { descriptionPreview, descriptionSections } from "./description-content";
import "./description-tooltip.css";

type DescriptionContextValue = {
  cache: Map<string, GridDescription>; error: string;
  show: (row: GridCompany, x: number, y: number) => void;
  move: (x: number, y: number) => void; hide: () => void;
};
const DescriptionContext = createContext<DescriptionContextValue | null>(null);
export function DescriptionCell({ row, columnId, source }: { row: GridCompany; columnId: string; source?: string }) {
  const context = useContext(DescriptionContext);
  const description = context?.cache.get(row.company_id);
  const text = descriptionPreview(description, columnId, source) ?? row.values?.[columnId] ?? row.description;
  return <span className="ws-grid-description" tabIndex={0}
    onPointerEnter={event => context?.show(row, event.clientX, event.clientY)}
    onPointerMove={event => context?.move(event.clientX, event.clientY)}
    onPointerLeave={() => context?.hide()}
    onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); context?.show(row, rect.left, rect.bottom); }}
    onKeyDown={event => { if (event.key === "Escape") context?.hide(); }}
    onBlur={() => context?.hide()}>{text == null ? "—" : String(text).replace(/^(MID|ISCC) Description: /, "")}</span>;
}
export default function DescriptionTooltip({ cache, error, children }: { cache: Map<string, GridDescription>; error: string; children: ReactNode }) {
  const [company, setCompany] = useState<GridCompany | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const frame = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const position = useCallback(() => {
    frame.current = 0;
    const node = element.current;
    if (!node) return;
    const x = Math.max(8, Math.min(pointer.current.x + 16, window.innerWidth - node.offsetWidth - 8));
    const y = Math.max(8, Math.min(pointer.current.y + 16, window.innerHeight - node.offsetHeight - 8));
    node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);
  const move = useCallback((x: number, y: number) => {
    pointer.current = { x, y };
    if (!frame.current) frame.current = requestAnimationFrame(position);
  }, [position]);
  const show = useCallback((row: GridCompany, x: number, y: number) => {
    clearTimeout(hideTimer.current); setCompany(row); move(x, y);
  }, [move]);
  const hide = useCallback(() => { hideTimer.current = setTimeout(() => setCompany(null), 140); }, []);
  useLayoutEffect(() => { if (company) position(); }, [company, cache, position]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(hideTimer.current); }, []);
  const sections = company ? descriptionSections(cache.get(company.company_id)) : [];
  return <DescriptionContext.Provider value={{ cache, error, show, move, hide }}>{children}
    {company && createPortal(<div ref={element} className="ws-description-tooltip" role="tooltip"
      onPointerEnter={() => clearTimeout(hideTimer.current)} onPointerLeave={() => setCompany(null)}
      onKeyDown={event => { if (event.key === "Escape") setCompany(null); }}>
      {sections.length ? sections.map((section, index) => <section key={index}>
        {index > 0 && <hr />}{section.heading && <h4>{section.heading}</h4>}
        {section.items.length ? section.items.map((item, i) => <p key={i}><strong>{item.label}:</strong> {item.text}</p>) : <p>No description available.</p>}
      </section>) : <p>{error ? `Descriptions unavailable: ${error}` : company && cache.has(company.company_id) ? "No description available." : "Loading descriptions…"}</p>}
    </div>, document.body)}
  </DescriptionContext.Provider>;
}
