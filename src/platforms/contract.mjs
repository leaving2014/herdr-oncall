import { randomUUID } from "node:crypto";

// The wire contract between a platform adapter and the bridge. Everything a
// gateway may route on is here; anything that names a terminal, a dialog
// fingerprint or a key sequence stays in `targetRef` and is never serialized.
export const PLATFORM_PROTOCOL_VERSION = 1;

function text(value, name, { required = true } = {}) {
  if (typeof value !== "string") {
    if (!required && value === undefined) {
      return "";
    }
    throw new Error(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) {
    throw new Error(`${name} must not be empty`);
  }
  return trimmed;
}

function stringList(value, name) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return [...new Set(value.map((item) => text(item, `${name}[]`)))];
}

function options(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("options must be an array");
  }
  const seen = new Set();
  return value.map((item) => {
    const key = text(item?.key, "options[].key");
    if (seen.has(key)) {
      throw new Error(`duplicate option key ${key}`);
    }
    seen.add(key);
    return { key, label: text(item?.label, "options[].label") };
  });
}

export function normalizePing(input = {}) {
  const status = text(input.status, "status");
  if (status !== "blocked" && status !== "done") {
    throw new Error("status must be blocked or done");
  }
  const ping = {
    protocolVersion: PLATFORM_PROTOCOL_VERSION,
    pingId: input.pingId ? text(input.pingId, "pingId") : randomUUID(),
    platform: text(input.platform, "platform"),
    instanceId: text(input.instanceId, "instanceId"),
    sessionId: text(input.sessionId, "sessionId"),
    status,
    title: text(input.title, "title"),
    body: text(input.body, "body", { required: false }),
    options: options(input.options),
    capabilities: stringList(input.capabilities, "capabilities"),
  };
  if (input.platformData !== undefined) {
    ping.platformData = input.platformData;
  }
  if (input.targetRef !== undefined) {
    ping.targetRef = input.targetRef;
  }
  return ping;
}

// What leaves this machine. `targetRef` is local by definition: sending it
// would let a gateway name a pane, which is exactly the authority it must not
// have.
export function gatewayPing(input) {
  const ping = normalizePing(input);
  delete ping.targetRef;
  return ping;
}

export function normalizeAnswer(input = {}) {
  const textValue = typeof input.text === "string" ? input.text.trim() : "";
  const actionKey = input.actionKey === undefined ? "" : text(input.actionKey, "actionKey");
  if (!textValue && !actionKey) {
    throw new Error("an answer needs text or actionKey");
  }
  const answer = {};
  if (textValue) {
    answer.text = textValue;
  }
  if (actionKey) {
    answer.actionKey = actionKey;
  }
  return answer;
}

export function assertPlatformAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("platform adapter must be an object");
  }
  if (!adapter.kind || typeof adapter.kind !== "string") {
    throw new Error("platform adapter needs a kind");
  }
  for (const name of ["describe", "start", "stop", "validate", "inject"]) {
    if (typeof adapter[name] !== "function") {
      throw new Error(`platform adapter ${adapter.kind} needs ${name}()`);
    }
  }
  return adapter;
}
