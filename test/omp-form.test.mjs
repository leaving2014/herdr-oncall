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
      { key: "1", label: "先验证冲突", send: "keys:enter" },
      { key: "2", label: "直接推进迁移", send: "keys:down,enter" },
      { key: "3", label: "不用干活", send: "keys:down,down,enter" },
      { key: "4", label: "Other: type your own", send: "keys:down,down,down,enter" },
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

test("an OMP form at its note step still gets a Submit button", () => {
  const noteOnly = `╭─ Ask · 1 of 2 answered ─────────────────────────────╮
│ ✓ 接下来要我先做哪一步？                            │
│ ❯ 要补充的话（可留空）                              │
│   │ ▏                                                │
│   Submit                                            │
╰─────────────────────────────────────────────────────╯
`;
  assert.deepEqual(parseBlockedOptions(noteOnly), [
    { key: "1", send: "keys:enter", label: "直接提交", submitOnly: true },
  ]);
  assert.equal(screenHasOpenMenu(noteOnly), true);
});

test("a checkbox question turns into toggle buttons", () => {
  const drinks = `╭─ Ask · 4 of 6 answered ─────────────────────────────╮
│ 喝的                                                │
│ ❯ ☐ 咖啡                                           │
│   ☐ 茶                                              │
│   ☐ Other: type your own                            │
│   Submit                                            │
╰─────────────────────────────────────────────────────╯
  󱊷 Asking several personal small-talk questions
`;
  assert.deepEqual(
    parseBlockedOptions(drinks).map(({ label, send }) => ({ label, send })),
    [
      { label: "咖啡", send: "keys:space" },
      { label: "茶", send: "keys:down,space" },
      { label: "Other: type your own", send: "keys:down,down,space" },
    ],
  );
});

test("a multi-question OMP form stays live", () => {
  const multi = `╭─ Ask · 2 of 6 answered ─────────────────────────────╮
│ 纯闲聊，几个问题，随手点就行。                      │
│ ✓ 最喜欢的颜色                                      │
│    ✓ 蓝色   绿色   黑/灰   暖色系                   │
│ 运动偏好                                            │
│ ❯ ○ 主要是看比赛                                    │
│   ○ 跑步 / 徒步                                     │
│   ○ Other: type your own                            │
│ ○ 理想的周末                                        │
│    出门走走   宅家                                  │
│ ✓ 一天里状态最好的时段                              │
│   10                                                │
│ ○ 随便再说一句（可留空）                            │
│   Submit                                            │
╰─────────────────────────────────────────────────────╯
  󱊷 Asking several personal small-talk questions
`;
  assert.equal(screenHasLiveDialog(multi), true);
  assert.equal(screenHasOpenMenu(multi), true);
  assert.deepEqual(
    parseBlockedOptions(multi).map(({ label }) => label),
    ["主要是看比赛", "跑步 / 徒步", "Other: type your own"],
  );
});

test("an OMP form whose title scrolled off still parses", () => {
  const headerless = `│ 随便问一个：你最近在纠结什么。                              │
│ ✓ 接下来要我先做哪一步？                                      │
│    先把 herdr 插件与网…   ✓ 不用干活                         │
│ ✓ 要补充的话（可留空）                                        │
│   什么都不用干                                                │
│ ❯ Submit                                                      │
`;
  assert.deepEqual(parseBlockedOptions(headerless), [
    { key: "1", send: "keys:enter", label: "直接提交", submitOnly: true },
  ]);
  assert.equal(screenHasOpenMenu(headerless), true);
  assert.match(blockedSnippet(headerless), /^随便问一个/);
});

test("a one-question OMP form defers the Enter to Submit", () => {
  const one = screen.replace("1 of 2 answered", "1 of 1 answered");
  assert.deepEqual(
    parseBlockedOptions(one).map(({ key, send }) => ({ key, send })),
    [
      { key: "1", send: "keys:" },
      { key: "2", send: "keys:down" },
      { key: "3", send: "keys:down,down" },
      { key: "4", send: "keys:down,down,down" },
    ],
  );
});

test("OMP header numbers may vary and still parse", () => {
  const changed = screen.replace("1 of 2 answered", "3 of 4 answered");
  assert.equal(dialogQuestion(changed), "接下来要我先做哪一步？");
  assert.equal(parseBlockedOptions(changed).length, 4);
});

test("OMP fingerprint follows a changed label", () => {
  const changed = screen.replace("直接推进迁移", "直接推进别的迁移");
  assert.notEqual(dialogFingerprint(screen), dialogFingerprint(changed));
});
