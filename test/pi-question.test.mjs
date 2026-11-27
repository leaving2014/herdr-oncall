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
        { send: "piopt:0:0", label: "第一个" },
        { send: "piopt:0:1", label: "第二个" },
      ],
    );
    assert.equal(lookupPiQuestion("om_pi_card").toolCallId, "call_123");

    let posted;
    const answered = await answerPiQuestion("om_pi_card", "", "piopt:0:1", {
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

test("a multi-question Pi prompt advances one card at a time", async () => {
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "oncall-pi-multi-"));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    const sent = [];
    const reply = async (text, { options }) => {
      const id = `om_${sent.length + 1}`;
      sent.push({ id, text, options });
      return id;
    };
    const questions = [
      { question: "第一题？", header: "一", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
      { question: "第二题？", header: "二", multiSelect: false, options: [{ label: "C" }, { label: "D" }] },
    ];
    const first = await handlePiQuestion(
      { toolCallId: "call_multi", answerUrl: "http://127.0.0.1:4568/answer", questions },
      { ping: reply },
    );
    assert.equal(first.messageId, "om_1");
    assert.match(sent[0].text, /第 1 \/ 2 题/);
    const next = await answerPiQuestion("om_1", "piopt:0:0", "", { ping: reply });
    assert.deepEqual(next, { ok: true, result: "next", messageId: "om_2" });
    assert.match(sent[1].text, /第 2 \/ 2 题/);
    assert.equal(sent[1].options[0].send, "piopt:1:0");

    let posted;
    const done = await answerPiQuestion("om_2", "piopt:1:1", "", {
      ping: reply,
      fetchImpl: async (url, options) => {
        posted = { url, options };
        return { ok: true, status: 200 };
      },
    });
    assert.deepEqual(done, { ok: true, result: "answered" });
    assert.deepEqual(JSON.parse(posted.options.body).answers, [
      { questionIndex: 0, optionIndexes: [0] },
      { questionIndex: 1, optionIndexes: [1] },
    ]);
  } finally {
    if (previous === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a multi-select Pi question accepts several option indexes", async () => {
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "oncall-pi-checkbox-"));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    let sent;
    let posted;
    const questions = [
      {
        question: "选哪些？",
        header: "多选",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      },
    ];
    const first = await handlePiQuestion(
      { toolCallId: "call_checkbox", answerUrl: "http://127.0.0.1:4569/answer", questions },
      {
        ping: async (text, { options }) => {
          sent = { text, options };
          return "om_checkbox";
        },
      },
    );
    assert.equal(first.ok, true);
    assert.deepEqual(sent.options.map((o) => ({ multi: o.multi, cursor: o.cursor })), [
      { multi: true, cursor: 0 },
      { multi: true, cursor: 0 },
      { multi: true, cursor: 0 },
    ]);
    await answerPiQuestion("om_checkbox", "multi:0:0,2", "", {
      fetchImpl: async (url, options) => {
        posted = JSON.parse(options.body);
        return { ok: true, status: 200 };
      },
    });
    assert.deepEqual(posted.answers, [{ questionIndex: 0, optionIndexes: [0, 2] }]);
  } finally {
    if (previous === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
