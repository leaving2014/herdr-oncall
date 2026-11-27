import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { stateDir, writeFileAtomic } from "../lib/index.mjs";
import { sendGatewayPing } from "../transport/gateway.mjs";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUESTION_TEXT = 3200;

function path() {
  return join(stateDir(), "pi-questions.json");
}

function read(now = Date.now()) {
  let store = {};
  try {
    store = JSON.parse(readFileSync(path(), "utf8")) || {};
  } catch {
    store = {};
  }
  const next = {};
  for (const [messageId, record] of Object.entries(store)) {
    if (record && Number(record.at) && now - Number(record.at) < TTL_MS) {
      next[messageId] = record;
    }
  }
  return next;
}

function write(store) {
  writeFileAtomic(path(), JSON.stringify(store));
}

export function lookupPiQuestion(messageId, now = Date.now()) {
  return read(now)[String(messageId)];
}

function remember(record) {
  const store = read();
  store[String(record.messageId)] = record;
  write(store);
}

function forget(messageId) {
  const store = read();
  delete store[String(messageId)];
  write(store);
}

function dirLabel(cwd) {
  if (!cwd) return "";
  const mode = (process.env.PI_QUESTION_DIR || "basename").trim().toLowerCase();
  if (mode === "hidden" || mode === "off") return "";
  const absolute = String(cwd);
  if (mode === "absolute") return absolute;
  if (mode === "home" || mode === "tilde") {
    const home = homedir();
    if (absolute === home) return "~";
    if (absolute.startsWith(`${home}${sep}`)) return `~${absolute.slice(home.length)}`;
  }
  return basename(absolute);
}

function textFor(questions, index, meta = {}) {
  const question = questions[index];
  const progress = questions.length > 1 ? `第 ${index + 1} / ${questions.length} 题` : "";
  const agent = ["Pi", dirLabel(meta.cwd)].filter(Boolean).join(" · ");
  return [agent, progress, question.question, question.header ? `标签：${question.header}` : ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_QUESTION_TEXT);
}

async function sendCard(questions, index, deps = {}, meta = {}) {
  const question = questions[index];
  const options = question.options.map((option, optionIndex) => ({
    key: String(optionIndex + 1),
    send: `piopt:${index}:${optionIndex}`,
    label: String(option?.label ?? "").slice(0, 96),
    whole: String(option?.label ?? ""),
    ...(question.multiSelect ? { multi: true, cursor: 0 } : {}),
  }));
  const send =
    deps.ping ??
    (async (text, { options }) => (await sendGatewayPing({ text, status: "blocked", options })).messageId);
  return send(textFor(questions, index, meta), { options });
}

// The Pi extension posts a prompt event here. A questionnaire is answered one
// card at a time: each option advances to the next question, and the last
// answer is posted back as one complete rpiv:ask-user:answer payload.
export async function handlePiQuestion(payload, deps = {}) {
  const toolCallId = String(payload?.toolCallId ?? "").trim();
  const answerMailbox = String(payload?.answerMailbox ?? "").trim();
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  if (!toolCallId || !answerMailbox || questions.length < 1) {
    return { ok: false, reason: "bad-question" };
  }
  const question = questions[0];
  if (!question || typeof question.question !== "string" || !Array.isArray(question.options)) {
    return { ok: false, reason: "bad-question" };
  }
  const mailboxRoot = join(stateDir(), "pi-answers");
  const mailbox = resolve(answerMailbox);
  if (mailbox !== mailboxRoot && !mailbox.startsWith(`${mailboxRoot}${sep}`)) {
    return { ok: false, reason: "answer-mailbox-outside-state" };
  }

  const meta = { cwd: String(payload?.cwd ?? ""), agent: "pi" };
  const messageId = await sendCard(questions, 0, deps, meta);
  if (!messageId) {
    return { ok: false, reason: "ping-failed" };
  }
  remember({
    messageId,
    toolCallId,
    answerMailbox: mailbox,
    questionIndex: 0,
    questions,
    answers: [],
    agent: meta.agent,
    cwd: meta.cwd,
    paneId: String(payload?.paneId ?? ""),
    at: Date.now(),
  });
  return { ok: true, messageId };
}

export async function answerPiQuestion(messageId, actionKey, text, deps = {}) {
  const record = lookupPiQuestion(messageId);
  if (!record) {
    return { ok: false, reason: "unknown-pi-question" };
  }
  const question = record.questions[record.questionIndex];
  if (!question) {
    return { ok: false, reason: "bad-question-state" };
  }
  let answer;
  // Gateway cards send a plain button's selected value in `text` (the card
  // action has no separate actionKey), while form fields use `actionKey`.
  const action = String(actionKey || text || "").trim();
  const multi = /^multi:(\d+):(.*)$/.exec(action);
  const option = /^piopt:(\d+):(\d+)$/.exec(action);
  if (multi) {
    const parts = action.split(":");
    const chosen = (parts[2] || "")
      .split(",")
      .map((item) => Number(item))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < question.options.length);
    const custom = parts[4] ? Buffer.from(parts.slice(4).join(":"), "base64").toString("utf8") : "";
    answer = {
      questionIndex: record.questionIndex,
      ...(chosen.length ? { optionIndexes: [...new Set(chosen)] } : {}),
      ...(custom ? { text: custom } : {}),
    };
    if (!answer.optionIndexes && !answer.text) {
      return { ok: false, reason: "empty-answer" };
    }
  } else if (option) {
    const questionIndex = Number(option[1]);
    const optionIndex = Number(option[2]);
    if (questionIndex !== record.questionIndex || !question.options[optionIndex]) {
      return { ok: false, reason: "bad-option" };
    }
    answer = { questionIndex, optionIndexes: [optionIndex] };
  } else if (String(text ?? "").trim()) {
    answer = { questionIndex: record.questionIndex, text: String(text).trim() };
  } else {
    return { ok: false, reason: "empty-answer" };
  }

  const answers = [...(record.answers ?? []), answer];
  const nextIndex = record.questionIndex + 1;
  if (nextIndex < record.questions.length) {
    let nextMessageId;
    try {
      nextMessageId = await sendCard(record.questions, nextIndex, deps, {
        agent: record.agent,
        cwd: record.cwd,
      });
    } catch (error) {
      return { ok: false, reason: `next-card-failed: ${error?.message || String(error)}` };
    }
    if (!nextMessageId) {
      return { ok: false, reason: "next-card-failed" };
    }
    const next = {
      ...record,
      messageId: nextMessageId,
      questionIndex: nextIndex,
      answers,
    };
    const store = read();
    delete store[String(messageId)];
    store[String(nextMessageId)] = next;
    write(store);
    return { ok: true, result: "next", messageId: nextMessageId };
  }

  try {
    mkdirSync(record.answerMailbox, { recursive: true });
    writeFileAtomic(
      join(record.answerMailbox, `${encodeURIComponent(record.toolCallId)}.json`),
      JSON.stringify({ toolCallId: record.toolCallId, answers }),
    );
  } catch (error) {
    return { ok: false, reason: `answer-write-failed: ${error?.message || String(error)}` };
  }
  forget(messageId);
  return { ok: true, result: "answered" };
}
