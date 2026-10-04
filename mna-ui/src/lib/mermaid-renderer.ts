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
        primaryColor: dark ? "#3b2e26" : "#f4e9e1",
        primaryTextColor: dark ? "#eeeae6" : "#302c28",
        primaryBorderColor: dark ? "#ab7957" : "#b88b6d",
        lineColor: dark ? "#a9a5a0" : "#77706a",
        secondaryColor: dark ? "#20392f" : "#e8f3ed",
        tertiaryColor: dark ? "#24272b" : "#f3f4f3",
        background: dark ? "#202226" : "#ffffff",
        mainBkg: dark ? "#302922" : "#f7eee8",
        edgeLabelBackground: dark ? "#202226" : "#ffffff",
        clusterBkg: dark ? "#282b2f" : "#f6f6f4",
        clusterBorder: dark ? "#42454a" : "#dadad6",
        textColor: dark ? "#eeeae6" : "#302c28",
      },
    });
    return (await mermaid.render(id, source)).svg;
  });
  renderQueue = next.catch(() => undefined);
  return next;
}
