import { currentPaneStatus } from "../lib/herdr.mjs";
import { runHerdr } from "../lib/paths.mjs";
import { deliverReply } from "../inbound/reply.mjs";
import { assertPlatformAdapter, normalizeAnswer } from "./contract.mjs";

// The classic Herdr adapter. Everything here already existed inside the hook:
// the adapter only gives it a name, so a bridge can drive it the same way it
// will drive herdr-core.
export function createHerdrAdapter({ run = runHerdr, deliver = deliverReply } = {}) {
  return assertPlatformAdapter({
    kind: "herdr",
    describe() {
      return {
        version: "1",
        capabilities: ["blocked", "done", "options", "text"],
      };
    },
    async start() {},
    async stop() {},
    async validate(ping) {
      const paneId = ping?.targetRef?.paneId;
      if (!paneId) {
        return "gone";
      }
      const status = currentPaneStatus(paneId, run);
      if (!status) {
        return "gone";
      }
      if (ping.status === "blocked" && status !== "blocked") {
        return "stale";
      }
      if (ping.status === "done" && status === "blocked") {
        return "stale";
      }
      return "valid";
    },
    async inject(ping, answer) {
      const paneId = ping?.targetRef?.paneId;
      if (!paneId) {
        return { result: "stale", reason: "no-target" };
      }
      const parsed = normalizeAnswer(answer);
      const text = parsed.text ?? parsed.actionKey;
      const result = deliver(paneId, text, ping.status, {
        fingerprint: ping.targetRef?.fingerprint,
        call: ping.targetRef?.call,
      });
      if (result?.stale) {
        return { result: "stale", reason: result.reason || "stale" };
      }
      if (result?.error || (typeof result?.status === "number" && result.status !== 0)) {
        return { result: "failed", detail: result.stderr || result.stdout || String(result.error || "") };
      }
      return { result: "sent" };
    },
  });
}
