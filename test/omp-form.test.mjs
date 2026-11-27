import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedSnippet,
  dialogFingerprint,
  dialogQuestion,
  parseBlockedOptions,
  screenHasLiveDialog,
  screenHasOpenMenu,
} from "../src/lib/format.mjs";

const screen = `  earlier output
╭─ Ask · 1 of 2 answered ─────────────────────────────────────────────╮
│ 接下来要我先做哪一步？                                              │
│ ❯ ◉ 先验证冲突                                                      │
│   ○ 直接推进迁移                                                    │
│   ○ 不用干活                                                        │
│   ○ Other: type your own                                            │
│                                                                     │
│ ○ 要补充的话（可留空）                                              │
│   比如：只验证冲突，不写代码                                        │
│                                                                     │
│   Submit                                                            │
╰─────────────────────────────────────────────────────────────────────╯
  󱊷 Asking one question via form
`;

test("OMP ask form yields a question and its radio choices", () => {
  assert.equal(dialogQuestion(screen), "接下来要我先做哪一步？");
  assert.deepEqual(
    parseBlockedOptions(screen).map(({ key, label, send }) => ({ key, label, send })),
    [
      { key: "1", label: "先验证冲突", send: "keys:enter,enter" },
      { key: "2", label: "直接推进迁移", send: "keys:down,enter,enter" },
      { key: "3", label: "不用干活", send: "keys:down,down,enter,enter" },
    ],
  );
  assert.equal(screenHasLiveDialog(screen), true);
  assert.equal(screenHasOpenMenu(screen), true);
});

test("OMP form snippet starts at the header and stops before Submit", () => {
  const snippet = blockedSnippet(screen);
  assert.match(snippet, /^Ask · 1 of 2 answered/);
  assert.match(snippet, /接下来要我先做哪一步？/);
  assert.match(snippet, /❯ ◉ 先验证冲突/);
  assert.doesNotMatch(snippet, /Submit/);
  assert.doesNotMatch(snippet, /╭|╰|│/);
});

test("OMP header numbers may vary and still parse", () => {
  const changed = screen.replace("1 of 2 answered", "3 of 4 answered");
  assert.equal(dialogQuestion(changed), "接下来要我先做哪一步？");
  assert.equal(parseBlockedOptions(changed).length, 3);
});

test("OMP fingerprint follows a changed label", () => {
  const changed = screen.replace("直接推进迁移", "直接推进别的迁移");
  assert.notEqual(dialogFingerprint(screen), dialogFingerprint(changed));
});
