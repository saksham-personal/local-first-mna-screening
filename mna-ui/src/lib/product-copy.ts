/** Presentation only: historical assistant receipts retain their original exported text. */
export function productCopy(text: string) {
  return text
    .replace(/\bDDI\b/gi, "Intake Form")
    .replace(/\bAsk M365 Copilot\b/gi, "M365 Copilot screening")
    .replace(/\bM365 Copilot screening a question\b/gi, "a question for M365 Copilot")
    .replace(/\bLLMSuite\b/gi, "LLM Suite")
    .replace(/\bLLM\b(?!\s+Suite\b)/gi, "LLM Suite")
    .replace(/real Rust tools/gi, "working tools")
    .replace(/Real Rust results/gi, "Saved results")
    .replace(/local Rust tools/gi, "local tools")
    .replace(/Local Rust/gi, "Local tools")
    .replace(/Rust company context/gi, "Saved company context")
    .replace(/saved in Rust/gi, "saved locally")
    .replace(/Rust stores/gi, "The application stores")
    .replace(/Rust checkpoints?/gi, (value) =>
      value.endsWith("s") ? "saved checkpoints" : "saved checkpoint",
    )
    .replace(/Rust run/gi, "saved run")
    .replace(
      /\bRust (tools?|server|job|executable|operations?|search|discovery|data)\b/gi,
      (_, noun: string) => `local ${noun}`,
    );
}
