import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function textFor(questions, index) {
  const question = questions[index];
  const progress = questions.length > 1 ? `第 ${index + 1} / ${questions.length} 题` : "";
  return [progress, question.question, question.header ? `标签：${question.header}` : ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_QUESTION_TEXT);
}

async function sendCard(questions, index, deps = {}) {
  const question = questions[index];
  const options = question.options.map((option, optionIndex) => ({
    key: String(optionIndex + 1),
    send: `piopt:${index}:${optionIndex}`,
    label: String(option?.label ?? "").slice(0, 96),
    whole: String(option?.label ?? ""),
  }));
  const send =
    deps.ping ??
    (async (text, { options }) => (await sendGatewayPing({ text, status: "blocked", options })).messageId);
  return send(textFor(questions, index), { options });
}

// The Pi extension posts a prompt event here. A questionnaire is answered one
// card at a time: each option advances to the next question, and the last
// answer is posted back as one complete rpiv:ask-user:answer payload.
export async function handlePiQuestion(payload, deps = {}) {
  const toolCallId = String(payload?.toolCallId ?? "").trim();
  const answerUrl = String(payload?.answerUrl ?? "").trim();
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  if (!toolCallId || !answerUrl || questions.length < 1) {
    return { ok: false, reason: "bad-question" };
  }
  const question = questions[0];
  if (!question || typeof question.question !== "string" || !Array.isArray(question.options)) {
    return { ok: false, reason: "bad-question" };
  }
  try {
    const url = new URL(answerUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      return { ok: false, reason: "answer-url-not-local" };
    }
  } catch {
    return { ok: false, reason: "bad-answer-url" };
  }

  const messageId = await sendCard(questions, 0, deps);
  if (!messageId) {
    return { ok: false, reason: "ping-failed" };
  }
  remember({
    messageId,
    toolCallId,
    answerUrl,
    answerToken: payload?.answerToken ? String(payload.answerToken) : undefined,
    questionIndex: 0,
    questions,
    answers: [],
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
  const option = /^piopt:(\d+):(\d+)$/.exec(String(actionKey ?? "").trim());
  if (option) {
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
      nextMessageId = await sendCard(record.questions, nextIndex, deps);
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

  const headers = { "content-type": "application/json" };
  if (record.answerToken) {
    headers.authorization = `Bearer ${record.answerToken}`;
  }
  try {
    const response = await (deps.fetchImpl ?? fetch)(record.answerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        toolCallId: record.toolCallId,
        answers,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { ok: false, reason: `answer-http-${response.status}` };
    }
  } catch (error) {
    return { ok: false, reason: `answer-failed: ${error?.message || String(error)}` };
  }
  forget(messageId);
  return { ok: true, result: "answered" };
}
