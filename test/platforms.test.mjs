import assert from "node:assert/strict";
import test from "node:test";
import { gatewayPing, normalizeAnswer, normalizePing } from "../src/platforms/contract.mjs";
import { createHerdrAdapter } from "../src/platforms/herdr.mjs";
import { createPlatformAdapter, platformKinds } from "../src/platforms/index.mjs";

const base = {
  platform: "herdr",
  instanceId: "instance-1",
  sessionId: "session-1",
  status: "blocked",
  title: "repo · feature/x · pane 2",
  body: "允许执行 git push 吗？",
  options: [{ key: "1", label: "允许一次" }],
};

test("normalizePing fills a stable wire shape", () => {
  const ping = normalizePing(base);
  assert.equal(ping.protocolVersion, 1);
  assert.match(ping.pingId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(ping.options, [{ key: "1", label: "允许一次" }]);
  assert.equal(ping.platformData, undefined);
});

test("gatewayPing never carries a local targetRef", () => {
  const ping = gatewayPing({ ...base, targetRef: { paneId: "w1:p2", fingerprint: "f" } });
  assert.equal("targetRef" in ping, false);
  assert.equal(normalizePing({ ...base, targetRef: { paneId: "w1:p2" } }).targetRef.paneId, "w1:p2");
});

test("contract rejects an unknown status and duplicate option keys", () => {
  assert.throws(() => normalizePing({ ...base, status: "working" }), /status/);
  assert.throws(
    () => normalizePing({ ...base, options: [{ key: "1", label: "a" }, { key: "1", label: "b" }] }),
    /duplicate/,
  );
});

test("normalizeAnswer needs words or a button key", () => {
  assert.deepEqual(normalizeAnswer({ text: " 1 " }), { text: "1" });
  assert.deepEqual(normalizeAnswer({ actionKey: "2" }), { actionKey: "2" });
  assert.throws(() => normalizeAnswer({}), /text or actionKey/);
});

test("herdr adapter validates the live pane and injects through the existing path", async () => {
  const calls = [];
  const run = (args) => {
    if (args[0] === "pane" && args[1] === "get") {
      if (args[2] === "w1:p2") {
        return { status: 0, stdout: JSON.stringify({ result: { agent_status: "blocked" } }) };
      }
      return { status: 1, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };
  const deliver = (...args) => {
    calls.push(args);
    return { status: 0 };
  };
  const adapter = createHerdrAdapter({ run, deliver });
  const ping = { ...normalizePing(base), targetRef: { paneId: "w1:p2", fingerprint: "fp" } };
  assert.equal(await adapter.validate(ping), "valid");
  assert.equal(await adapter.validate({ ...ping, targetRef: { paneId: "w1:p9" } }), "gone");
  assert.equal(await adapter.validate({ ...ping, status: "done" }), "stale");
  assert.deepEqual(await adapter.inject(ping, { actionKey: "1" }), { result: "sent" });
  assert.equal(calls[0][0], "w1:p2");
  assert.equal(calls[0][1], "1");
  assert.equal(calls[0][3].fingerprint, "fp");
});

test("the registry rejects unknown platforms", () => {
  assert.ok(platformKinds().includes("herdr"));
  assert.equal(createPlatformAdapter("herdr").kind, "herdr");
  assert.throws(() => createPlatformAdapter("nope"), /unknown platform/);
});
