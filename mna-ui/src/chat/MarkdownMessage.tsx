import { useEffect, useId, useState } from "react";
import {
  MarkdownTextPrimitive,
  type MarkdownTextPrimitiveProps,
  type SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import "./artifacts.css";
import { useTheme } from "../lib/theme-store";
import { useAuiState } from "@assistant-ui/react";
import { productCopy } from "../lib/product-copy";
import { renderDiagram } from "../lib/mermaid-renderer";

function MermaidBlock({ code }: SyntaxHighlighterProps) {
  const id = useId().replaceAll(":", "");
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  const { resolved: theme } = useTheme();

  useEffect(() => {
    let active = true;
    setSvg("");
    setFailed(false);
    void renderDiagram(`ca-markdown-${id}`, code, theme)
      .then((rendered) => {
        if (active) setSvg(rendered);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [code, id, theme]);

  if (failed)
    return (
      <div className="ca-mermaid-fallback">
        <p>Diagram could not be rendered. Source:</p>
        <pre>{code}</pre>
      </div>
    );
  if (!svg)
    return (
      <div className="ca-mermaid-loading" role="status">
        Rendering diagram…
      </div>
    );
  return (
    <div
      className="ca-markdown-mermaid"
      aria-label="Mermaid diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const markdownProps: Pick<MarkdownTextPrimitiveProps, "componentsByLanguage"> =
  {
    componentsByLanguage: { mermaid: { SyntaxHighlighter: MermaidBlock } },
  };

/** Assistant-ui text-part renderer. Use as the `Text` component in MessagePrimitive.Parts. */
export default function MarkdownMessage() {
  const assistant = useAuiState((state) => state.message.role === "assistant");
  return (
    <MarkdownTextPrimitive
      className="ca-markdown"
      {...markdownProps}
      preprocess={assistant ? productCopy : undefined}
    />
  );
}

/** Plain standalone fallback for places outside an assistant-ui message runtime. */
export function StandaloneMarkdown({ text }: { text: string }) {
  return <pre className="ca-standalone-plain">{text}</pre>;
}
