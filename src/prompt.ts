/**
 * Turn Paperclip's execution context into the `input` a harness receives.
 *
 * HarnessRouter has no opinion about Paperclip's wake protocol, so the mapping
 * lives here. It is deliberately explicit rather than "stringify the context":
 * a stable prompt shape makes runs reproducible and keeps unknown internal
 * context keys out of a third party's logs.
 */

export interface PromptContext {
  agent: { id: string; companyId: string; name: string };
  runId: string;
  context: Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Context keys that are safe and useful to render; everything else is ignored. */
const RENDERED_CONTEXT_KEYS = ["issueId", "issueKey", "issueTitle", "taskId", "conversationMode"] as const;

export function buildPrompt(input: PromptContext): string {
  const { agent, runId, context } = input;

  const explicit = nonEmpty(context.prompt);
  const wakePrompt = nonEmpty(context.wakePrompt);
  const taskNote = nonEmpty(context.taskContextNote);

  const header = [
    `You are ${agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${agent.id}`,
    `- Company ID: ${agent.companyId}`,
    `- Run ID: ${runId}`,
  ];

  const rendered = RENDERED_CONTEXT_KEYS.map((key) => {
    const value = context[key];
    if (value === undefined || value === null || value === "") return null;
    return `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  }).filter((line): line is string => line !== null);

  const sections: string[] = [...header, ...rendered, ""];

  if (wakePrompt) sections.push(wakePrompt);
  if (taskNote) sections.push("", taskNote);
  if (explicit) sections.push("", explicit);

  // Nothing task-shaped was supplied: hand over the context rather than sending
  // an empty string, which some providers reject and all of them bill for.
  if (!wakePrompt && !taskNote && !explicit) {
    sections.push(
      "",
      "Execution context JSON:",
      "```json",
      JSON.stringify(context, null, 2).slice(0, 20_000),
      "```",
    );
  }

  return sections.join("\n").trim();
}
