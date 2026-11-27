import assert from "node:assert/strict";
import test from "node:test";
import { handleGatewayReply } from "../src/inbound/gateway.mjs";
import { sendGatewayPing, startGatewayCallbackServer } from "../src/transport/gateway.mjs";

const env = {
  ONCALL_GATEWAY_URL: "http://gateway.test/",
  ONCALL_GATEWAY_TOKEN: "gateway-token",
  ONCALL_GATEWAY_CHAT_ID: "oc_test",
  ONCALL_CALLBACK_TOKEN: "callback-token",
};

test("sendGatewayPing posts one ping and returns the gateway message id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messageId: "om_1", channel: "feishu" }),
    };
  };
  const result = await sendGatewayPing(
    { text: "允许吗？", status: "blocked", options: [{ key: "1", label: "允许" }], pingId: "p1" },
    { env, fetchImpl },
  );
  assert.deepEqual(result, { messageId: "om_1", channel: "feishu" });
  assert.equal(calls[0].url, "http://gateway.test/api/oncall/ping");
  assert.equal(calls[0].init.headers.authorization, "Bearer gateway-token");
  assert.equal(calls[0].init.headers["idempotency-key"], "p1");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chatId, "oc_test");
  assert.equal(body.status, "blocked");
  assert.deepEqual(body.options, [{ key: "1", label: "允许" }]);
});

test("sendGatewayPing reports a gateway refusal with its body", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: "bad token" }),
  });
  await assert.rejects(
    () => sendGatewayPing({ text: "x", status: "blocked" }, { env, fetchImpl }),
    (error) => error.status === 401 && error.body.error === "bad token",
  );
});

test("gateway callback checks the bearer token and returns the delivery result", async () => {
  const seen = [];
  const server = await startGatewayCallbackServer({
    env,
    port: 0,
    onReply: async (payload) => {
      seen.push(payload);
      return payload.messageId === "om_1" ? { ok: true, result: "sent" } : { ok: false, reason: "unknown-ping" };
    },
  });
  try {
    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200);

    const denied = await fetch(`${server.url}/oncall/reply`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ messageId: "om_1", text: "1" }),
    });
    assert.equal(denied.status, 401);

    const ok = await fetch(`${server.url}/oncall/reply`, {
      method: "POST",
      headers: { authorization: "Bearer callback-token", "content-type": "application/json" },
      body: JSON.stringify({ messageId: "om_1", actionKey: "1" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, result: "sent" });
    assert.deepEqual(seen, [{ messageId: "om_1", actionKey: "1" }]);

    const unknown = await fetch(`${server.url}/oncall/reply`, {
      method: "POST",
      headers: { authorization: "Bearer callback-token", "content-type": "application/json" },
      body: JSON.stringify({ messageId: "om_x", text: "1" }),
    });
    assert.deepEqual(await unknown.json(), { ok: false, reason: "unknown-ping" });
  } finally {
    await server.close();
  }
});

test("handleGatewayReply turns a named message into a pane delivery", async () => {
  const finished = [];
  const outcome = await handleGatewayReply(
    { messageId: "om_9", actionKey: "2" },
    {
      lookup: (id) => (id === "om_9" ? { paneId: "w1:p2", status: "blocked", fingerprint: "fp" } : undefined),
      finish: async (target, parts, deps) => {
        finished.push({ target, parts, deps });
        return { ok: true };
      },
      channel: { name: "gateway", reply: async () => "om_ack" },
    },
  );
  assert.deepEqual(outcome, { ok: true, result: "sent" });
  assert.equal(finished[0].target.explicit, true);
  assert.equal(finished[0].target.paneId, "w1:p2");
  assert.deepEqual(finished[0].parts, [{ type: "text", text: "2" }]);
});

test("handleGatewayReply refuses a stale dialog and an unknown message", async () => {
  assert.deepEqual(
    await handleGatewayReply(
      { messageId: "om_9", text: "1" },
      {
        lookup: () => ({ paneId: "w1:p2", status: "blocked" }),
        finish: async () => ({ ok: false, stale: true }),
        channel: { name: "gateway", reply: async () => "om_ack" },
      },
    ),
    { ok: false, reason: "stale-dialog" },
  );
  assert.deepEqual(await handleGatewayReply({ messageId: "om_none", text: "1" }, { lookup: () => undefined }), {
    ok: false,
    reason: "unknown-ping",
  });
});
