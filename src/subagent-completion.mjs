import { randomUUID } from "node:crypto";

// Codex 0.147 keeps a finished child visually Working after FINAL_ANSWER while
// the parent turn is still live. close_agent is not in the v2 toolset;
// interrupt_agent is the only model-callable close path. Parents frequently
// ignore the usage-hint text on long multi-agent turns (San Francisco is the
// pathological case), so the router injects the missing interrupts itself.
//
// This module only decides *what* to inject. The response transform in
// namespace-relay.mjs is what splices the calls into the stream without shifting
// sequence numbers of model-authored items.

const FINAL_ANSWER_HEADER =
  /Message Type:\s*FINAL_ANSWER\b[\s\S]*?\nSender:\s*(\S+)/gi;
const NATIVE_ENCRYPTED_TOKEN = /^gAAAAA[A-Za-z0-9_-]+={0,2}$/;
// A FINAL_ANSWER envelope can also be a checkpoint from an implementer. The
// parent must be able to resume that child, so an explicit incomplete marker
// is not evidence that the child is ready for an interrupt. Keep this matcher
// deliberately narrow: it looks only at the payload (not ordinary user/model
// prose) and requires either a status word or an unambiguous delivery phrase.
const INCOMPLETE_FINAL_STATUS =
  /\b(?:status|statut|result|résultat|verdict)(?:\s+[^\n:]{1,40})?\s*[:=-]\s*(?:partial|in[_ -]?progress|incomplete|unfinished)\b/i;
const INCOMPLETE_FINAL_DELIVERY =
  /\b(?:still\s+in\s+progress|work\s+in\s+progress|not\s+(?:yet\s+)?delivered|not\s+(?:yet\s+)?complete|en\s+cours|pas\s+(?:encore\s+)?livr(?:é|e|ée|es)|non\s+livr(?:é|e|ée|es))\b/i;

export function isIncompleteFinalAnswer(text) {
  if (typeof text !== "string" || !text) return false;
  const payload = text.match(/\nPayload:\s*([\s\S]*)$/i)?.[1] || text;
  return INCOMPLETE_FINAL_STATUS.test(payload) || INCOMPLETE_FINAL_DELIVERY.test(payload);
}

// A close must always name a child. "/root" (and its bare and slashed forms)
// is the parent itself, and interrupting it would cancel the turn that is
// still running -- so a sender that resolves to the root is never a target.
function isRootTarget(target) {
  if (typeof target !== "string") return true;
  const normalized = target.replace(/^\/+/, "").replace(/^root\/?/, "");
  return normalized === "";
}

function contentPartsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (
      (part.type === "input_text" ||
        part.type === "output_text" ||
        part.type === "text") &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
      continue;
    }
    // Routed children store the plaintext handoff under encrypted_content when
    // the parent never touched the native backend. Native Fernet tokens are
    // skipped: we cannot read them, and they are not FINAL_ANSWER text.
    if (
      part.type === "encrypted_content" &&
      typeof part.encrypted_content === "string" &&
      part.encrypted_content.length > 0 &&
      !NATIVE_ENCRYPTED_TOKEN.test(part.encrypted_content)
    ) {
      parts.push(part.encrypted_content);
    }
  }
  return parts.join("");
}

function itemText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.content === "string") return item.content;
  return contentPartsText(item.content);
}

export function extractFinalAnswerTargetsFromText(text) {
  if (typeof text !== "string" || !text) return [];
  const targets = [];
  FINAL_ANSWER_HEADER.lastIndex = 0;
  for (const match of text.matchAll(FINAL_ANSWER_HEADER)) {
    const sender = match[1]?.trim();
    if (sender) targets.push(sender);
  }
  return targets;
}

function declaredAgentMessageTargets(item, text = itemText(item)) {
  if (item?.type !== "agent_message") return [];
  const fromText = extractFinalAnswerTargetsFromText(text);
  if (fromText.length) return fromText;
  // Structured author is enough when the envelope declares FINAL_ANSWER, even
  // if Sender was stripped during relay.
  if (
    typeof item.author === "string" &&
    item.author &&
    /Message Type:\s*FINAL_ANSWER\b/i.test(text)
  ) {
    return [item.author];
  }
  return [];
}

function targetsFromAgentMessage(item) {
  if (item?.type !== "agent_message") return [];
  const text = itemText(item);
  // FINAL_ANSWER is a transport envelope, not a promise that the requested
  // deliverable is complete. Leave explicit PARTIAL/in-progress checkpoints
  // resumable; the parent can follow up and close the child after that result.
  if (isIncompleteFinalAnswer(text)) return [];
  return declaredAgentMessageTargets(item, text);
}

function parseFunctionCallArgs(item) {
  if (typeof item?.arguments !== "string" || !item.arguments) return undefined;
  try {
    const args = JSON.parse(item.arguments);
    if (args && typeof args === "object" && !Array.isArray(args)) return args;
  } catch {
    // Malformed arguments stay unparsed.
  }
  return undefined;
}

export function isInterruptAgentCall(item) {
  if (!item || item.type !== "function_call") return false;
  if (item.namespace === "collaboration" && item.name === "interrupt_agent") {
    return true;
  }
  return item.name === "collaboration__interrupt_agent" || item.name === "interrupt_agent";
}

export function interruptTargetFromCall(item) {
  if (!isInterruptAgentCall(item)) return undefined;
  const args = parseFunctionCallArgs(item);
  const target = args?.target;
  return typeof target === "string" && target.trim() ? target.trim() : undefined;
}

// A parent may deliberately keep a completed child alive long enough to send
// a follow-up. The automatic closer must yield to that explicit request for
// this response; otherwise the injected interrupt races the follow-up and the
// child never gets a chance to answer it.
export function followupTargetFromCall(item) {
  if (!item || (item.type !== "function_call" && item.type !== "custom_tool_call")) {
    return undefined;
  }
  const nativeName =
    item.namespace === "collaboration" ? item.name : undefined;
  const flatName = item.namespace === undefined ? item.name : undefined;
  if (
    nativeName !== "send_message" &&
    nativeName !== "followup_task" &&
    flatName !== "collaboration__send_message" &&
    flatName !== "collaboration__followup_task"
  ) {
    return undefined;
  }
  const args = parseFunctionCallArgs(item);
  const target = args?.target;
  return typeof target === "string" && target.trim() ? target.trim() : undefined;
}

export function collaborationToolAvailable(namespaces) {
  if (!(namespaces instanceof Map)) return false;
  const names = namespaces.get("collaboration");
  return names instanceof Set && names.has("interrupt_agent");
}

// Walk the request input once. Returns every child that has already finished
// (FINAL_ANSWER seen) and every child the parent has already interrupted, so
// the response path only injects the missing closes.
//
// Evidence of a finished child comes from `agent_message` items only -- the
// envelope type Codex uses for collaboration traffic on both the native and
// routed paths. Ordinary `message` items are the operator's and the model's
// own prose; scanning them meant a turn that merely *quoted* a FINAL_ANSWER
// envelope (docs, a changelog, this very feature under discussion) had a
// fabricated interrupt_agent call spliced into its response.
export function collectFinishedSubagentState(input) {
  const finished = new Set();
  const interrupted = new Set();
  if (!Array.isArray(input)) {
    return { finished, interrupted, pending: [] };
  }
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const target = interruptTargetFromCall(item);
      if (target) interrupted.add(target);
      continue;
    }
    if (item.type === "agent_message") {
      const text = itemText(item);
      const declared = declaredAgentMessageTargets(item, text);
      if (isIncompleteFinalAnswer(text)) {
        // A follow-up can produce a later checkpoint for a child that had
        // already reported a prior turn complete. The latest explicit status
        // wins: remove it from the auto-close set so it remains resumable.
        for (const target of declared) {
          if (!isRootTarget(target)) finished.delete(target);
        }
        continue;
      }
      for (const target of targetsFromAgentMessage(item)) {
        if (!isRootTarget(target)) finished.add(target);
      }
    }
  }
  const pending = [...finished].filter((target) => !interrupted.has(target));
  return { finished, interrupted, pending };
}

export function pendingInterruptTargets(
  input,
  {
    namespaces,
    // Only enforce the tool check when the request actually advertised a
    // non-empty inventory. Empty/unknown inventories (native deferred tools)
    // still queue closes for finished children. That bypass is safe only
    // because detection is scoped to `agent_message` envelopes: an ordinary
    // turn cannot contain one, so an empty inventory plus quoted envelope
    // text can no longer manufacture an interrupt.
    requireCollaborationTool = namespaces instanceof Map && namespaces.size > 0,
  } = {},
) {
  if (
    requireCollaborationTool &&
    namespaces &&
    !collaborationToolAvailable(namespaces)
  ) {
    return [];
  }
  return collectFinishedSubagentState(input).pending;
}

function sameTarget(a, b) {
  if (a === b) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Codex accepts both "/root/child" and "child" forms for interrupt_agent.
  const normalize = (value) => value.replace(/^\/+/, "").replace(/^root\//, "");
  return normalize(a) === normalize(b);
}

export function filterAlreadyInterrupted(pending, interruptedTargets) {
  if (!Array.isArray(pending) || pending.length === 0) return [];
  if (!interruptedTargets || interruptedTargets.size === 0) return [...pending];
  return pending.filter(
    (target) => ![...interruptedTargets].some((done) => sameTarget(done, target)),
  );
}

export function buildInterruptAgentCall(target, { callId, flattened = false } = {}) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("interrupt_agent target is required");
  }
  const id =
    typeof callId === "string" && callId
      ? callId
      // Injected calls survive in the conversation history, while the relay
      // transform is recreated for every HTTP turn. A per-turn counter would
      // therefore reuse `call_router_interrupt_1` on the next turn.
      : `call_router_interrupt_${randomUUID().replaceAll("-", "")}`;
  if (flattened) {
    return {
      type: "function_call",
      name: "collaboration__interrupt_agent",
      call_id: id,
      arguments: JSON.stringify({ target }),
    };
  }
  return {
    type: "function_call",
    name: "interrupt_agent",
    namespace: "collaboration",
    call_id: id,
    arguments: JSON.stringify({ target }),
  };
}

// Build the SSE events for one injected interrupt. Sequence numbers are filled
// by the stream transform once it knows the last model-emitted sequence.
export function interruptAgentSseEvents(target, { callId, sequenceStart = 1 } = {}) {
  const item = buildInterruptAgentCall(target, { callId, flattened: false });
  const addedSeq = sequenceStart;
  const doneSeq = sequenceStart + 1;
  return [
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        sequence_number: addedSeq,
        item: {
          type: "function_call",
          name: item.name,
          namespace: item.namespace,
          call_id: item.call_id,
          arguments: "",
        },
      },
    },
    {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        sequence_number: doneSeq,
        item: {
          type: "function_call",
          name: item.name,
          namespace: item.namespace,
          call_id: item.call_id,
          arguments: item.arguments,
        },
      },
    },
  ];
}

export function formatSseBlock(eventName, data) {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}
