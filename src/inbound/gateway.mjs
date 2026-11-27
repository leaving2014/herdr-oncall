import { textParts } from "../lib/index.mjs";
import { sendGatewayPing } from "../transport/gateway.mjs";
import { finishDelivery, lookupOutbound } from "./reply.mjs";
import { answerPiQuestion, lookupPiQuestion } from "./pi-question.mjs";

export function gatewayChannel(deps = {}) {
  const send = deps.send ?? sendGatewayPing;
  return {
    name: "gateway",
    reply: async (text) => (await send({ text, status: "message" }, deps)).messageId,
    ping: async (text, { options = [] } = {}) =>
      (await send({ text, status: options.length ? "blocked" : "done", options }, deps)).messageId,
  };
}

// A gateway callback names the message it answers. Unlike a Feishu event it
// carries no sender identity: the gateway already accepted only its owner's
// chat, and the callback token authenticates the gateway itself.
export async function handleGatewayReply(payload, deps = {}) {
  const messageId = String(payload?.messageId ?? "").trim();
  if (!messageId) {
    return { ok: false, reason: "missing-message-id" };
  }
  const actionKey = String(payload?.actionKey ?? "").trim();
  const text = String(payload?.text ?? "").trim();
  if (!actionKey && !text) {
    return { ok: false, reason: "empty-answer" };
  }
  // A Pi questionnaire has its own answer channel (the rpiv event bus), not
  // a pane: its card is answered by index/text, never by typing keys.
  if ((deps.lookupPi ?? lookupPiQuestion)(messageId)) {
    const outcome = await (deps.answerPi ?? answerPiQuestion)(messageId, actionKey, text, deps);
    if (outcome?.ok === false) {
      return { ok: false, reason: outcome.reason || "pi-answer-failed" };
    }
    return { ok: true, result: outcome?.result || "answered" };
  }
  const lookup = deps.lookup ?? lookupOutbound;
  const record = lookup(messageId);
  if (!record?.paneId) {
    return { ok: false, reason: "unknown-ping" };
  }
  const finish = deps.finish ?? finishDelivery;
  const channel = deps.channel ?? gatewayChannel(deps);
  const outcome = await finish(
    { ...record, messageId, explicit: true },
    textParts(actionKey || text),
    { ...deps, channel },
  );
  if (outcome?.stale) {
    return { ok: false, reason: "stale-dialog" };
  }
  if (outcome?.refused) {
    return { ok: false, reason: "refused" };
  }
  return outcome?.ok === false ? { ok: false, reason: "inject-failed" } : { ok: true, result: "sent" };
}
