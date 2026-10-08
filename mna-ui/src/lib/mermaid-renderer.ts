import type { ResolvedTheme } from "./theme-store";

// Mermaid's configuration is global. Serialize configuration and rendering so
// two diagrams or a theme change cannot give one another the wrong palette.
let renderQueue: Promise<unknown> = Promise.resolve();

export function renderDiagram(
  id: string,
  source: string,
  theme: ResolvedTheme,
): Promise<string> {
  const next = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    const dark = theme === "dark";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        darkMode: dark,
        fontFamily: "Geist Variable, system-ui, sans-serif",
        fontSize: "14px",
        primaryColor: dark ? "#273c59" : "#eaf0f8",
        primaryTextColor: dark ? "#edf2f8" : "#252a30",
        primaryBorderColor: dark ? "#9fc4ff" : "#315c91",
        lineColor: dark ? "#9aa8ba" : "#6b7480",
        secondaryColor: dark ? "#20392f" : "#e8f3ed",
        tertiaryColor: dark ? "#222e3e" : "#f2f3f1",
        background: dark ? "#1b2532" : "#ffffff",
        mainBkg: dark ? "#253244" : "#f3f6fb",
        edgeLabelBackground: dark ? "#1b2532" : "#ffffff",
        clusterBkg: dark ? "#222e3e" : "#f7f7f5",
        clusterBorder: dark ? "#42526a" : "#dde1e6",
        textColor: dark ? "#edf2f8" : "#252a30",
      },
    });
    return (await mermaid.render(id, source)).svg;
  });
  renderQueue = next.catch(() => undefined);
  return next;
}
