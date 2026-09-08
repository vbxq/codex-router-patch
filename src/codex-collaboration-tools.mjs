// The app-server owns the collaboration runtime, but routed models do not
// always receive its deferred namespace declaration. Keep a small, stable
// declaration here so the router can relay the same native calls through a
// chat-completions provider and restore them on egress.

const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

const optionalString = { type: "string" };

export const CODEX_COLLABORATION_TOOLS = {
  type: "namespace",
  name: "collaboration",
  description: "Tools for spawning and managing Codex sub-agents.",
  tools: [
    {
      type: "function",
      name: "spawn_agent",
      description: "Spawn a sub-agent for a well-scoped task.",
      inputSchema: {
        type: "object",
        properties: {
          task_name: { type: "string" },
          message: { type: "string" },
          model: optionalString,
          reasoning_effort: { type: "string", enum: REASONING_EFFORTS },
        },
        required: ["task_name", "message"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "wait_agent",
      description:
        "Wait for a sub-agent to finish or need attention. For long work use timeout_ms=3600000. A timed_out=true result is only an observation timeout, not completion: call wait_agent again and do not interrupt the child. A PARTIAL or in-progress report also requires a follow-up or another wait.",
      inputSchema: {
        type: "object",
        properties: {
          timeout_ms: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "interrupt_agent",
      description:
        "Interrupt a sub-agent only after it explicitly reports complete, or an idle/errored wait proves it cannot continue or is no longer needed. Do not interrupt a PARTIAL, in-progress, incomplete, or not-delivered report; send followup_task/send_message first and wait for that result.",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "send_message",
      description: "Send a message to a running sub-agent.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string" },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "followup_task",
      description:
        "Send a follow-up task to an existing sub-agent, especially when its report is PARTIAL or in progress. Request the missing deliverables, then call wait_agent again before interrupt_agent.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string" },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "list_agents",
      description: "List the sub-agents in the current collaboration tree.",
      inputSchema: {
        type: "object",
        properties: { path_prefix: optionalString },
        additionalProperties: false,
      },
    },
  ],
};

export function mergeCodexCollaborationTools(tools) {
  if (!Array.isArray(tools)) return { tools, merged: false };
  const existing = tools.find(
    (tool) => tool?.type === "namespace" && tool.name === "collaboration",
  );
  if (existing) {
    const present = new Set(
      (Array.isArray(existing.tools) ? existing.tools : [])
        .filter((tool) => tool?.type === "function" && tool.name)
        .map((tool) => tool.name),
    );
    const missing = CODEX_COLLABORATION_TOOLS.tools.filter(
      (tool) => !present.has(tool.name),
    );
    if (!missing.length) return { tools, merged: false };
    return {
      tools: tools.map((tool) =>
        tool === existing
          ? {
              ...tool,
              tools: [
                ...(Array.isArray(tool.tools) ? tool.tools : []),
                ...missing,
              ],
            }
          : tool,
      ),
      merged: true,
    };
  }
  return { tools: [...tools, CODEX_COLLABORATION_TOOLS], merged: true };
}
