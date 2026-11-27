import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { answerPiQuestion, handlePiQuestion, lookupPiQuestion } from "../src/inbound/pi-question.mjs";

test("a Pi prompt becomes a card and a chosen option goes back as an answer", async () => {
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "oncall-pi-"));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    let sent;
    const result = await handlePiQuestion(
      {
        toolCallId: "call_123",
        paneId: "w1:p1",
        answerUrl: "http://127.0.0.1:4567/answer",
        answerToken: "local-token",
        questions: [
          {
            question: "选哪一个？",
            header: "选择",
            multiSelect: false,
            options: [
              { label: "第一个", description: "a" },
              { label: "第二个", description: "b" },
            ],
          },
        ],
      },
      {
        ping: async (text, { options }) => {
          sent = { text, options };
          return "om_pi_card";
        },
      },
    );
    assert.deepEqual(result, { ok: true, messageId: "om_pi_card" });
    assert.match(sent.text, /选哪一个/);
    assert.deepEqual(
      sent.options.map(({ send, label }) => ({ send, label })),
      [
        { send: "piopt:0", label: "第一个" },
        { send: "piopt:1", label: "第二个" },
      ],
    );
    assert.equal(lookupPiQuestion("om_pi_card").toolCallId, "call_123");

    let posted;
    const answered = await answerPiQuestion("om_pi_card", "piopt:1", "", {
      fetchImpl: async (url, options) => {
        posted = { url, options };
        return { ok: true, status: 200 };
      },
    });
    assert.deepEqual(answered, { ok: true, result: "answered" });
    assert.equal(posted.url, "http://127.0.0.1:4567/answer");
    assert.equal(posted.options.headers.authorization, "Bearer local-token");
    assert.deepEqual(JSON.parse(posted.options.body), {
      toolCallId: "call_123",
      answers: [{ questionIndex: 0, optionIndexes: [1] }],
    });
    assert.equal(lookupPiQuestion("om_pi_card"), undefined);
  } finally {
    if (previous === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
