import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const DEFAULT_PORT = 8790;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY = 64 * 1024;

function envText(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function envPort(env, name, fallback) {
  const value = Number(envText(env, name));
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : fallback;
}

export function gatewayConfig(env = process.env) {
  const url = envText(env, "ONCALL_GATEWAY_URL").replace(/\/+$/, "");
  const token = envText(env, "ONCALL_GATEWAY_TOKEN");
  const callbackToken = envText(env, "ONCALL_CALLBACK_TOKEN") || token;
  return {
    url,
    token,
    channel: envText(env, "ONCALL_GATEWAY_CHANNEL") || "feishu",
    botId: envText(env, "ONCALL_GATEWAY_BOT_ID"),
    chatId: envText(env, "ONCALL_GATEWAY_CHAT_ID"),
    callback: {
      host: envText(env, "ONCALL_CALLBACK_HOST") || "127.0.0.1",
      port: envPort(env, "ONCALL_CALLBACK_PORT", DEFAULT_PORT),
      token: callbackToken,
    },
  };
}

export function gatewayPaired(env = process.env) {
  const config = gatewayConfig(env);
  return Boolean(config.url && config.token && config.callback.token);
}

export class GatewayError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.body = body;
  }
}

function bearer(header, token) {
  const prefix = "Bearer ";
  if (typeof header !== "string" || !header.startsWith(prefix)) {
    return false;
  }
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function replyJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function sendGatewayPing(payload, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = gatewayConfig(env);
  if (!config.url || !config.token) {
    throw new GatewayError("gateway is not configured (ONCALL_GATEWAY_URL / ONCALL_GATEWAY_TOKEN)");
  }
  if (typeof fetchImpl !== "function") {
    throw new GatewayError("fetch is unavailable");
  }
  const body = {
    channel: config.channel,
    status: payload.status,
    text: payload.text,
    options: payload.options ?? [],
  };
  if (config.botId) body.botId = config.botId;
  if (config.chatId) body.chatId = config.chatId;
  for (const name of ["pingId", "title", "body", "platform", "instanceId", "sessionId", "capabilities", "platformData"]) {
    if (payload[name] !== undefined) {
      body[name] = payload[name];
    }
  }
  const response = await fetchImpl(`${config.url}/api/oncall/ping`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      ...(body.pingId ? { "idempotency-key": body.pingId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }
  if (!response.ok) {
    throw new GatewayError(`gateway ping failed (${response.status})`, { status: response.status, body: data });
  }
  if (!data?.messageId) {
    throw new GatewayError("gateway ping returned no messageId", { status: response.status, body: data });
  }
  return data;
}

// The gateway calls back into the machine rather than the plugin long-polling
// it. That keeps a reply on the same path as a Feishu event: the gateway knows
// which message was quoted, the plugin still owns the pane check.
export async function startGatewayCallbackServer({
  onReply,
  env = process.env,
  host,
  port,
  log = console.log,
} = {}) {
  if (typeof onReply !== "function") {
    throw new Error("startGatewayCallbackServer needs onReply(payload)");
  }
  const config = gatewayConfig(env);
  if (!config.callback.token) {
    throw new Error("gateway callback token is empty");
  }
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      replyJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST" || req.url !== "/oncall/reply") {
      replyJson(res, 404, { ok: false, reason: "not-found" });
      return;
    }
    if (!bearer(req.headers.authorization, config.callback.token)) {
      replyJson(res, 401, { ok: false, reason: "unauthorized" });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      replyJson(res, 400, { ok: false, reason: "bad-request", detail: error?.message || String(error) });
      return;
    }
    try {
      const outcome = (await onReply(body)) ?? { ok: true };
      replyJson(res, 200, outcome);
    } catch (error) {
      log(`gateway callback failed: ${error?.stack || error?.message || error}`);
      replyJson(res, 500, { ok: false, reason: "internal" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? config.callback.port, host ?? config.callback.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : config.callback.port;
  return {
    server,
    port: boundPort,
    url: `http://${host ?? config.callback.host}:${boundPort}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
