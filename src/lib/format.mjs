import { createHash } from "node:crypto";
import { basename } from "node:path";
import { stripAnsi } from "./herdr.mjs";
import { sleep } from "./paths.mjs";
import { worktreeFrom, worktreeLabel, worktreeShortName } from "./worktree.mjs";

// Answering one question of a multi-question form does not end the pane's wait:
// the form advances to its next tab in place, and Herdr fires no event for it.
// Whoever delivered the answer — the hook behind the desktop panel, or the
// poller behind a Telegram reply — has to find the question that replaces it,
// or the rest of the form sits in the terminal with nobody told.
//
// The screen decides, not the status: Herdr's detection lags a redraw, and a
// pane it briefly calls `working` can already have the next question drawn.
// The status only ends the wait early, and only `working` may: it means the
// answer was taken and the agent went on. `done` and `idle` say nothing about a
// form — Herdr has called one done, and then idle, the whole time it sat there
// waiting — so a read that lands mid-redraw must not be taken for the end of it.
export async function nextDialog({
  read,
  status,
  answered,
  attempts = 16,
  delayMs = 500,
  wait = sleep,
}) {
  for (let i = 0; i < attempts; i++) {
    await wait(delayMs);
    const screen = await read();
    if (String(screen ?? "").trim() && screenHasLiveDialog(screen)) {
      const fingerprint = dialogFingerprint(screen);
      if (fingerprint && fingerprint !== answered) {
        return { screen, fingerprint };
      }
      // The same question is still on screen; the redraw has not landed yet.
      continue;
    }
    if (status?.() === "working") {
      return undefined;
    }
  }
  return undefined;
}

export function paneIdFrom(event, context) {
  const raw =
    event?.data?.pane_id ??
    event?.pane_id ??
    context.pane_id ??
    context.focused_pane_id ??
    "";
  return String(raw);
}

export function blockedSnippet(screen, limit = 24) {
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  if (region?.omp) {
    const scope = (process.env.OMP_ASK_SCOPE || "all").trim().toLowerCase();
    return capSnippet(scope === "current" ? renderOmpCurrent(lines, region) : renderOmpBlock(lines, region));
  }
  const slice = region
    ? lines.slice(region.start, region.end)
    : lines.filter((line) => !isBlank(line)).slice(-limit);
  return capSnippet(renderBlock(slice));
}

// The question a dialog asks in words ("Do you want to proceed?"), or "" for
// one that only draws its choices.
export function dialogQuestion(screen) {
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  if (!region || region.header === region.optionStart) {
    return "";
  }
  if (region.omp) {
    const question = lines
      .slice(region.header + 1, region.optionStart)
      .map(ompLineText)
      .find((line) => /[?？]\s*$/.test(line));
    return question ?? ompLineText(lines[region.header]);
  }
  return lines[region.header].trim();
}

// Is a dialog actually waiting on this screen, as opposed to one an agent
// merely printed earlier in the transcript?
//
// A live dialog is the last thing the terminal drew: only key hints, the
// prompt box and status lines come after it. Quoted text always has real
// content below it. Herdr's own detector matches dialog wording anywhere in
// the recent buffer, so a pane can be reported `blocked` purely because the
// agent discussed a permission prompt — this is the check that tells the two
// apart, and it reads the pane over Herdr's socket, so it works no matter what
// is on the physical display.
export function screenHasLiveDialog(screen) {
  const lines = screenLines(screen);
  if (!lines.some((line) => !isBlank(line))) {
    return false;
  }
  const region = dialogRegion(lines);
  if (!region) {
    return false;
  }
  if (region.omp) {
    for (let i = region.end + 1; i < lines.length; i++) {
      const line = lines[i];
      // OMP's own "Asking ..." status sits below Submit; everything after it
      // is the footer/status bar, never a new agent answer.
      if (/Asking\b.*\bquestions?\b/i.test(line)) {
        return true;
      }
      if (isBlank(line) || isRuleLine(line) || isFooterAt(lines, i)) {
        continue;
      }
      return false;
    }
    return true;
  }
  for (let i = region.end; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isRuleLine(line) || isFooterAt(lines, i)) {
      continue;
    }
    return false;
  }
  return true;
}

// A menu waiting on a keypress right now, as opposed to a numbered list the
// agent ended its turn with. `screenHasLiveDialog` cannot tell those two apart:
// a turn that closes on "1. … 2. …" is followed by nothing but the empty prompt
// box and its footer, which is exactly what sits under a real dialog. What a
// list in prose never has is the selection cursor — a menu draws `❯`/`›` on the
// choice Enter would take. It also takes two choices to make a menu, which
// keeps a draft typed into the prompt box ("❯ 1. first…") out of it.
//
// This is the check that overrules Herdr when it misses a question: Claude
// Code's multi-question form has been reported `done`, and then `idle`, with
// the form still up and waiting.
export function screenHasOpenMenu(screen) {
  if (!screenHasLiveDialog(screen)) {
    return false;
  }
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  if (region?.omp) {
    // An OMP form is a dialog even when its choices are folded away and only
    // the note field and Submit are left. Treating it as a menu keeps typed
    // card input on the text+Enter path instead of herdr's prompt path.
    return true;
  }
  if (region?.optionStart === undefined) {
    return false;
  }
  const cursor = lines
    .slice(region.optionStart, region.end)
    .some((line) => /^\s*[❯›▸]\s*\d{1,2}[.)、]\s+\S/.test(line));
  return cursor && parseBlockedOptions(screen).length >= 2;
}

// OMP's ask tool draws a different form:
//
//   ╭─ Ask · 1 of 2 answered ─────────────────────────────╮
//   │ 接下来要我先做哪一步？                              │
//   │ ❯ ◉ 先验证冲突                                      │
//   │   ○ 直接迁移                                        │
//   │   ○ Other: type your own                            │
//   │                                                     │
//   │ ○ 要补充的话（可留空）                              │
//   │   Submit                                            │
//   ╰─────────────────────────────────────────────────────╯
//
// It has no numbered choices and its labels use radio glyphs. Recognising this
// form keeps its silent screen dump from becoming one long text ping, and gives
// the notification its question and its first run of radio choices.
function ompLineText(raw) {
  return stripAnsi(raw)
    .replace(/^[\s╭╰─│┃|]+/, "")
    .replace(/[\s╮╯─│┃|]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ompInnerText(raw) {
  return stripAnsi(raw)
    .replace(/^\s*│/, "")
    .replace(/│\s*$/, "")
    .replace(/\s+$/, "");
}

function ompOptionAt(line) {
  const text = ompInnerText(line);
  const match = text.match(/^(\s*)(?:(❯|›|▸|>)\s*)?([◉○●⚪☐☑☒])\s+(.+)$/u);
  if (!match) {
    return undefined;
  }
  const cursor = Boolean(match[2]);
  // The open question's choices are indented two or more spaces; a folded
  // question is drawn as a single `○ 标题` row with one leading space.
  if (!cursor && match[1].length < 2) {
    return undefined;
  }
  return {
    cursor,
    multi: /[☐☑☒]/.test(match[3]),
    selected: /[◉●☑☒]/.test(match[3]),
    label: match[4].trim(),
  };
}

function ompFormRegion(lines) {
  let submit = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(?:[❯›▸>]\s*)?Submit\b/i.test(ompLineText(lines[i]))) {
      submit = i;
      break;
    }
  }
  if (submit < 0) {
    return undefined;
  }
  let header = -1;
  for (let i = submit - 1; i >= 0; i--) {
    if (/^Ask\s*[·•]\s*\d+\s+of\s+\d+\s+answered/i.test(ompLineText(lines[i]))) {
      header = i;
      break;
    }
  }
  // The form grows past the viewport as questions are answered; its title
  // scrolls off before its Submit row does. Only the boxed body is left, so
  // anchor the region on Submit and walk back over the box lines.
  let start = header;
  if (start < 0) {
    start = submit;
    while (start > 0) {
      const text = stripAnsi(lines[start - 1]).trim();
      if (!text || !/^[│╭╰┌└]/.test(text)) {
        break;
      }
      start -= 1;
    }
  }
  let optionStart = -1;
  let optionEnd = -1;
  for (let i = start + 1; i < submit; i++) {
    if (ompOptionAt(lines[i])) {
      if (optionStart < 0) {
        optionStart = i;
      }
      optionEnd = i;
      continue;
    }
    if (optionStart >= 0 && isBlank(ompLineText(lines[i]))) {
      break;
    }
  }
  const raw = [];
  if (optionStart >= 0) {
    for (let i = optionStart; i <= optionEnd; i++) {
      const option = ompOptionAt(lines[i]);
      if (option) {
        raw.push(option);
      }
    }
  }
  const cursor = Math.max(0, raw.findIndex((option) => option.cursor));
  const multi = raw.some((option) => option.multi);
  const total = Number(/of\s+(\d+)\s+answered/i.exec(ompLineText(lines[header] ?? ""))?.[1] ?? 1);
  const options = [];
  for (const [index, option] of raw.entries()) {
    const keys = [];
    for (let step = 0; step < Math.abs(index - cursor); step += 1) {
      keys.push(index > cursor ? "down" : "up");
    }
    const other = /^Other\b/i.test(option.label);
    if (multi) {
      // Checkboxes toggle with Space and stay put; Submit presses Enter to
      // advance. This lets several card taps pick several values.
      keys.push("space");
    } else if (total > 1) {
      // A longer form needs Enter to advance from the choice question to the
      // note the card's input fills.
      keys.push("enter");
    }
    options.push({
      key: String(options.length + 1),
      send: `keys:${keys.join(",")}`,
      label: option.label.slice(0, 96),
      whole: option.label,
      ...(multi ? { multi: true, cursor } : {}),
    });
  }
  return {
    omp: true,
    start,
    header: header < 0 ? start : header,
    optionStart: optionStart < 0 ? submit : optionStart,
    optionEnd,
    end: submit,
    options: options.slice(0, 9),
  };
}

// The live form is one viewport. When the reader only needs the question waiting
// for an answer, print its progress line and the open question instead of the
// whole form; answered and folded questions are the noise this avoids.
function renderOmpCurrent(lines, region) {
  const out = [];
  const header = region.header >= 0 ? ompLineText(lines[region.header]) : "";
  const progress = /Ask\s*[·•]\s*(\d+)\s+of\s+(\d+)/i.exec(header);
  if (progress) {
    // The header counts answered questions ("Ask · 6 of 7" while the seventh
    // is focused), so the open question is the next one, capped at the total
    // for the note step after the last answer.
    const total = Number(progress[2]);
    const current = Math.min(Number(progress[1]) + 1, total);
    out.push(`当前问题：第 ${current} 题 / 共 ${total} 题`);
  }

  const start = ompCurrentStart(lines, region);
  const end = ompCurrentEnd(lines, region, start);
  for (let i = start; i < end; i++) {
    const text = ompLineText(lines[i]);
    if (!text) {
      if (out.length && out.at(-1) !== "") {
        out.push("");
      }
      continue;
    }
    out.push(text);
  }
  while (out.length && out.at(-1) === "") {
    out.pop();
  }
  return out.join("\n").trim();
}

function ompCurrentStart(lines, region) {
  if (region.optionEnd >= region.optionStart) {
    // The open question's label sits immediately above its choices. A folded
    // `✓ ...` row above it belongs to an earlier question and must not come
    // along.
    let i = region.optionStart - 1;
    while (i > region.start && isBlank(ompLineText(lines[i]))) {
      i -= 1;
    }
    if (
      i > region.start &&
      !ompOptionAt(lines[i]) &&
      !/^\s*[✓✔☑☒]/.test(ompInnerText(lines[i]))
    ) {
      return i;
    }
    return region.optionStart;
  }
  // A text-only question is the row carrying OMP's cursor below the folded
  // questions; its field and Submit run down to the next folded question.
  for (let i = region.end - 1; i >= region.start; i--) {
    if (ompInnerText(lines[i]).includes("❯")) {
      return i;
    }
  }
  return region.start;
}

function ompCurrentEnd(lines, region, start) {
  if (region.optionEnd >= region.optionStart) {
    return region.optionEnd + 1;
  }
  for (let i = start + 1; i < region.end; i++) {
    const inner = ompInnerText(lines[i]);
    const text = ompLineText(lines[i]);
    if (/^\s{0,1}[○◉☐☑]\s+/.test(inner) && !inner.includes("❯")) {
      return i;
    }
    if (/^(?:[❯›▸>]\s*)?Submit\b/i.test(text)) {
      return i;
    }
  }
  return region.end;
}


// The last answer leaves OMP's Submit control focused. That is not another
// question: the form can be submitted, or its questions and answers can be
// reported once, without offering an input that has nothing left to answer.
export function ompFormComplete(screen) {
  const lines = screenLines(screen);
  const region = ompFormRegion(lines);
  if (!region?.omp) {
    return false;
  }
  const header = region.header >= 0 ? ompLineText(lines[region.header]) : "";
  const progress = /Ask\s*[·•]\s*(\d+)\s+of\s+(\d+)/i.exec(header);
  if (!progress || Number(progress[1]) < Number(progress[2])) {
    return false;
  }
  // "6 of 6" can also be the last question still open. Only a focused Submit
  // row means the form is finished.
  return region.optionStart === region.end && /^\s*[❯›▸>]\s*Submit\b/i.test(ompInnerText(lines[region.end]));
}

// An OMP question with no choices is an input field, not a key menu. A single
// digit typed into it must be typed (and the old value cleared first), not sent
// as a keypress into the existing contents (`7` + `8` became `87`).
export function dialogHasTextInput(screen) {
  const lines = screenLines(screen);
  const region = ompFormRegion(lines);
  if (!region?.omp || ompFormComplete(screen) || parseOmpDropdown(screen)) {
    return false;
  }
  return region.optionStart === region.end;
}

// OMP's completed form is a flat list: a `✓` question row, then its answer
// row(s). Render that once for the chat so the final message is a record, not
// another card with an input box.
export function ompFormSummary(screen) {
  const lines = screenLines(screen);
  const region = ompFormRegion(lines);
  if (!region?.omp || !ompFormComplete(screen)) {
    return "";
  }
  const entries = [];
  let current;
  for (let i = region.start; i < region.end; i++) {
    const inner = ompInnerText(lines[i]);
    const trimmed = inner.trim();
    if (!trimmed) {
      continue;
    }
    if (/^(?:[❯›▸>]\s*)?Submit\b/i.test(trimmed)) {
      continue;
    }
    const indent = /^\s*/.exec(inner)?.[0].length ?? 0;
    const question = /^[✓✔]\s+(.+)$/u.exec(trimmed);
    if (question && indent <= 1) {
      current = { question: question[1].trim(), answers: [] };
      entries.push(current);
      continue;
    }
    if (current && indent >= 2) {
      const answer = trimmed
        .replace(/[✓✔☑☒◉●○]\s*/gu, "")
        .replace(/\s+/g, " ")
        .trim();
      if (answer) {
        current.answers.push(answer);
      }
    }
  }
  if (!entries.length) {
    return "";
  }
  const body = entries
    .map((entry, index) => `${index + 1}. ${entry.question}：${entry.answers.join(" ") || "（未填）"}`)
    .join("\n");
  return `全部问题与回答（${entries.length}/${entries.length}）\n${body}`;
}

function renderOmpBlock(lines, region) {
  const out = [];
  for (let i = region.start; i < region.end; i++) {
    const text = ompLineText(lines[i]);
    if (!text) {
      if (out.length && out.at(-1) !== "") {
        out.push("");
      }
      continue;
    }
    out.push(text);
  }
  while (out.length && out.at(-1) === "") {
    out.pop();
  }
  return out.join("\n").trim();
}

// The dialog as the terminal drew it: where the content being approved starts,
// where the question is, and where the options end. Boundaries come from the
// UI's own structure (turn markers, rules, paragraph breaks), never from a
// line count — the input is one viewport, so there is nothing to guard against.
export function dialogRegion(lines) {
  const omp = ompFormRegion(lines);
  if (omp) {
    return omp;
  }
  const options = trailingOptionRun(lines);
  const header = questionIndex(lines, options);
  if (header < 0 && !options) {
    return undefined;
  }
  const anchor = header >= 0 ? header : options.start;
  return {
    start: dialogStartIndex(lines, anchor, options),
    header: anchor,
    optionStart: options?.start,
    end: options ? options.end : dialogEndIndex(lines, anchor),
  };
}

// The choices are always the last thing a dialog draws: the run of numbered
// lines at the bottom of the screen, below any prose and above the key hints.
// Numbered lines higher up belong to the description or to earlier chat, and
// taking the first run instead of this one is what once put a workflow's phase
// list on the buttons.
function trailingOptionRun(lines) {
  let bottom = -1;
  let end = -1;
  let tailIndent = Infinity;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (isBlank(line) || isRuleLine(line) || isFooterAt(lines, i)) {
      continue;
    }
    if (isOptionLine(line)) {
      bottom = i;
      if (end < 0) {
        end = i + 1;
      }
      break;
    }
    // The last choice's own wrapped tail sits below it, so it is the first
    // thing this scan meets. It is part of the run, not the end of it: stepping
    // over it keeps the run findable, and stretching `end` past it keeps the
    // tail in the region, where `joinWrappedOptions` puts it back on the label.
    // The option itself is checked first, because "3. No (esc)" ends the same
    // way its wrapped tail would.
    if (endsInKeyParenthetical(line)) {
      if (end < 0) {
        end = i + 1;
      }
      tailIndent = Math.min(tailIndent, indentOf(line));
      continue;
    }
    break;
  }
  if (bottom < 0) {
    return undefined;
  }
  // A wrapped option continues on a more indented line; anything at or left of
  // the option column ends the run.
  const column = indentOf(lines[bottom]);
  // A tail hangs under its label. One at or left of the option column is not a
  // tail but content below the choices, and a dialog with content under it is
  // not the last thing on screen.
  if (tailIndent <= column) {
    return undefined;
  }
  let top = bottom;
  let lowest = optionNumber(lines[bottom]);
  for (let i = bottom - 1; i >= 0; i--) {
    const line = lines[i];
    if (isOptionLine(line)) {
      top = i;
      lowest = optionNumber(line) ?? lowest;
      continue;
    }
    // A multi-question form draws a rule *inside* its choice list — Claude
    // Code's tabbed form puts "Chat about this" in its own section under the
    // divider. Cross it only when the line above continues the numbering
    // downward, so an unrelated list further up is still never pulled in.
    if (isRuleLine(line)) {
      const above = lines[i - 1];
      if (above !== undefined && isOptionLine(above) && optionNumber(above) === lowest - 1) {
        continue;
      }
      break;
    }
    if (isBlank(line) || isTurnMarker(line)) {
      break;
    }
    // A choice's description hangs under it, deeper than the numbers, and can
    // read like a key hint: "Esc to abandon the change" under "2. Go back".
    // Taken for chrome, it ended the run there and the choices above it were
    // lost — buttons gone, and the cursor on one of them no longer an open
    // menu. Hanging under a choice settles it: that is a description.
    if (isChromeLine(line) && !(indentOf(line) > column && hangsUnderOption(lines, i, column))) {
      break;
    }
    if (indentOf(line) > column) {
      top = i;
      continue;
    }
    break;
  }
  return { start: top, end };
}

// Does line `i` belong to the choice above it — every line between them hung
// deeper than the option column, with no blank in the way?
function hangsUnderOption(lines, i, column) {
  for (let j = i - 1; j >= 0; j--) {
    const line = lines[j];
    if (isOptionLine(line)) {
      return true;
    }
    if (isBlank(line) || indentOf(line) <= column) {
      return false;
    }
  }
  return false;
}

function optionNumber(line) {
  const match = cleanOptionLine(line).match(/^(\d{1,2})[.)、]\s+\S/);
  return match ? Number(match[1]) : undefined;
}

// The question owning those choices: the nearest line above them that ends in a
// question mark. It stops at the same structural boundaries as the body walk,
// so a question from an earlier turn cannot be picked up.
function questionIndex(lines, options) {
  if (options) {
    let blanks = 0;
    for (let i = options.start - 1; i >= 0; i--) {
      const line = lines[i];
      if (isBlank(line)) {
        if (++blanks >= 2) {
          break;
        }
        continue;
      }
      blanks = 0;
      if (isUserMarker(line) || isRuleLine(line)) {
        break;
      }
      // Fullwidth `？` ends a question written in Chinese or Japanese just as
      // `?` ends an English one; matching only the ASCII form left a real
      // question unfound and the snippet with nothing but its choices.
      if (/[?？]\s*$/.test(line)) {
        return i;
      }
      if (isTurnMarker(line)) {
        break;
      }
    }
  }
  return keywordHeaderIndex(lines);
}

// No numbered choices on screen (a bare y/n prompt): name the question by its
// wording instead. Prefer the last match so earlier prose that merely mentions
// permissions does not win.
function keywordHeaderIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(would you like|do you want|allow|permission)[^?？]*[?？]/i.test(lines[i])) {
      return i;
    }
  }
  return lines.findIndex(
    (line) =>
      /would you like|do you want|allow |permission|environment:/i.test(line) || /^\s*\$ /.test(line),
  );
}

function indentOf(line) {
  return String(line).match(/^\s*/)[0].length;
}

// The content being approved sits above the question only when the options
// follow it with nothing in between. When lines separate the two — Codex
// printing "Environment:" and the command under the question — the content is
// below and the question is the start. Otherwise walk up to the first
// structural boundary: the turn marker or tool header that owns this block,
// the previous user turn, a drawn rule, or a paragraph break.
function dialogStartIndex(lines, header, options) {
  if (!options || hasContentBetween(lines, header, options.start)) {
    return header;
  }
  let start = header;
  let blanks = 0;
  while (start > 0) {
    const prev = lines[start - 1];
    if (isBlank(prev)) {
      if (++blanks >= 2) {
        break;
      }
      start--;
      continue;
    }
    blanks = 0;
    if (isUserMarker(prev) || isRuleLine(prev)) {
      break;
    }
    start--;
    if (isTurnMarker(prev) || isToolHeaderLine(prev)) {
      break;
    }
  }
  return start;
}

function hasContentBetween(lines, from, to) {
  for (let i = from + 1; i < to; i++) {
    if (!isBlank(lines[i]) && !isRuleLine(lines[i])) {
      return true;
    }
  }
  return false;
}

// "⏺ Bash(...)" in Claude Code, "● Edit" in others: the line that owns the
// block below it.
function isTurnMarker(line) {
  return /^\s{0,4}[⏺●⚫]\s+\S/.test(line);
}

// Codex names the tool on its own header line instead of using a marker glyph.
function isToolHeaderLine(line) {
  const text = line.trim();
  return /^(bash|shell|local shell|read|write|edit|update|multi-?edit|apply.?patch|web.?fetch|web.?search|task|glob|grep)\b.{0,60}$/i.test(
    text,
  );
}

function isOptionLine(line) {
  return /^\s*[❯›▸>]?\s*\d{1,2}[.)、]\s+\S/.test(cleanOptionLine(line));
}

// A line that ends in a bare key name in parentheses — "(shift+tab)", "(esc)" —
// is the tail of an option, wrapped by the terminal past the pane width, and
// never a footer. Claude Code draws "2. Yes, and always allow access to
// /Users/… for this session (shift+tab)" and breaks it wherever the width
// says: once leaving "(shift+tab)" alone on the last line, once with the word
// before it, "session (shift+tab)". While `shift+tab` counted as a key hint,
// the walk up the choice list stopped dead at that tail, both times, and the
// panel opened with one button ("3. No") while the other two choices sat
// stranded in the body. A real key hint says what the key *does* ("shift+tab
// to cycle", "esc to interrupt"), so its parentheses never hold a bare key.
function endsInKeyParenthetical(line) {
  return /\(\s*[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*\s*\)$/.test(String(line).trim());
}

// Stop before the spinner, prompt box, or status line that the visible screen
// carries below a dialog with no numbered options.
function dialogEndIndex(lines, header) {
  let blanks = 0;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      if (++blanks >= 2) {
        return i;
      }
      continue;
    }
    blanks = 0;
    if (isChromeLine(line) || isUserMarker(line) || isTurnMarker(line)) {
      return i;
    }
  }
  return lines.length;
}

// Drop the drawn borders, trim the edges, and collapse blank runs so the block
// reads the same in Telegram and in the panel.
function renderBlock(slice) {
  const kept = slice.filter((line) => !isRuleLine(line));
  const out = [];
  for (const line of kept) {
    if (isBlank(line)) {
      if (out.length && !isBlank(out.at(-1))) {
        out.push("");
      }
      continue;
    }
    out.push(line);
  }
  while (out.length && isBlank(out.at(-1))) {
    out.pop();
  }
  return out.join("\n").trim();
}

export function doneSnippet(screen, limit = 40) {
  const lines = screenLines(screen).filter((line) => !isChromeLine(line) && !isRuleLine(line));
  if (!lines.length) {
    return "";
  }
  const users = lines.flatMap((line, index) => (isUserMarker(line) ? [index] : []));
  let start = users.at(-1) ?? -1;
  let end = lines.length;
  // The prompt box reads exactly like a turn the user sent: Claude Code draws
  // it as "❯ <whatever is typed>", Codex as "› Ask Codex to do anything" even
  // when it is empty, and only footers sit under it. Telling it apart by
  // recognising every footer kept failing as the agents grew new ones — Codex's
  // model line and shortcut hints made a done ping whose whole body was the
  // footer. Where the agent's turns are on screen, structure settles it: a user
  // line with no turn after it is the box, so the last turn ends there and
  // starts at the user line before it.
  if (start >= 0 && lines.slice(0, start).some(isTurnStart) && !lines.slice(start + 1).some(isTurnStart)) {
    end = start;
    start = users.at(-2) ?? -1;
  }
  let body = trimBodyTail(lines.slice(start + 1, end));
  // Nothing left under that "user turn" means it was the prompt box, not a
  // message, on a screen with no turn to anchor on. Fall back to the tail so
  // the ping carries the agent's answer rather than whatever survived
  // underneath the box.
  if (!body.length) {
    body = trimBodyTail(lines.slice(0, end).slice(-limit));
  }
  if (body.length > limit) {
    body = body.slice(-limit);
  }
  return capSnippet(body.join("\n").trim());
}

// The first line of an agent's turn: "⏺" or "●" in Claude Code, "•" in Codex.
// Unlike `isTurnMarker`, which bounds a dialog, it takes Codex's bullet — and
// only at the left edge, because Codex draws the list items inside an answer
// with the same glyph, indented.
function isTurnStart(line) {
  return /^\s?[⏺●⚫•]\s+\S/.test(line);
}

function trimBodyTail(body) {
  const out = [...body];
  while (out.length && (isUserMarker(out.at(-1)) || isChromeLine(out.at(-1)))) {
    out.pop();
  }
  return out;
}

// Lines as the terminal drew them. Blank lines and drawn rules are kept: they
// are the boundaries between blocks, and dropping them is what forces guesswork
// like "take the last N lines". Consumers filter what they do not want.
function screenLines(screen) {
  return stripAnsi(screen)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
}

function isBlank(line) {
  return !String(line).trim();
}

// A drawn border or separator: "\u2500\u2500\u2500\u2500", "\u256D\u2500\u2500\u256E", and the labelled kind the
// agents draw across the width of the pane \u2014 "\u2500\u2500\u2500\u2500 ultracode \u21AF \u2500" \u2014 where a
// short caption sits inside a long run of box-drawing characters.
function isRuleLine(line) {
  const text = String(line).trim();
  if (text.length < 3) {
    return false;
  }
  if (/^[\u2500-\u257F\u2580-\u259F\s]+$/.test(text)) {
    return true;
  }
  const box = (text.match(/[\u2500-\u257F\u2580-\u259F]/g) || []).length;
  return box >= 8 && box / text.length >= 0.5;
}

function isChromeLine(line) {
  const text = line.trim();
  if (!text) {
    return true;
  }
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷•·●○]+$/.test(text)) {
    return true;
  }
  if (/^(idle|done|finished|working|blocked|thinking|ready)\b/i.test(text) && text.length < 24) {
    return true;
  }
  // A line that ends in a bare key name in parentheses is the tail of an
  // option, wrapped by the terminal — never a footer. See
  // `endsInKeyParenthetical`.
  if (endsInKeyParenthetical(text)) {
    return false;
  }
  // Key hints and the spinner footer. `tokens` must carry its count: the bare
  // word matched any short line that merely mentioned one, and an option whose
  // description read "任何人可从 auth-service 取到 API token" was read as a
  // footer — the walk up the choice list stopped dead there and the ping went
  // out with the first two options missing.
  if (
    /(\b\d+(?:\.\d+)?k?\s*tokens?\b|\bcontext window\b|\besc to \b|\bpress (enter|esc)\b|\bctrl\+|\binterrupt\b|\bshift\+tab\b)/i.test(
      text,
    ) &&
    text.length < 96
  ) {
    return true;
  }
  // Status footers the agents draw under everything else: Claude Code's
  // "➜ repo git:(main) ctx:33% Opus 5", Codex's "» Ask Codex to do anything".
  if (/\bctx:\d+%/.test(text) || /^»\s/.test(text)) {
    return true;
  }
  // Codex's footer under its prompt box: the model line "GPT-6-Astra high ·
  // ~/repo · branch" (model, reasoning effort, then the working directory) and
  // the hint line "← for agents · ? for shortcuts   ⚠ 2 warnings · f2 to view".
  // A done event lands while Codex repaints, when these and the box are all
  // there is, and read as content they made the ping out of the footer alone.
  // The effort word is not listed: the first capture said `high`, the next
  // machine said `ultra`. Model, one word, a dot, a path is the shape.
  if (/^[\w.-]+(?:\s+[\w.-]+)?\s+·\s+[~/]/.test(text) || /(?:^|\s)\?\s+for shortcuts\b/i.test(text)) {
    return true;
  }
  // Claude Code's task list, drawn under the prompt box and so *below* a live
  // dialog: a "4 tasks (3 done, 1 in progress, 0 open)" summary and one
  // glyph-led row per task. Counting those rows as content is what made a real
  // permission prompt read as one merely quoted in the transcript — the panel
  // stopped opening for any pane with a todo list, and the options went missing
  // with it, since the choice run is found by walking up past the chrome.
  if (/^\d+\s+tasks?\s*\(/i.test(text)) {
    return true;
  }
  if (/^[✔✓☑◼◻☐■□▪▫]\s+\S/.test(text)) {
    return true;
  }
  // Claude Code's permission-mode footer, drawn under the prompt box. It reads
  // "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents" on a bare pane but
  // "⏵⏵ accept edits on · 1 monitor · ← 1 agent" once monitors or agents are
  // attached — no key hint, no token count, nothing else here matched it. So it
  // counted as content, and a done ping went out with the footer as its whole
  // body. The `⏵⏵` marker is the footer, whatever it goes on to say.
  if (/^⏵{1,2}\s/.test(text)) {
    return true;
  }
  if (/^[❯›▸$]\s*$/.test(text) || /^codex>\s*$/i.test(text)) {
    return true;
  }
  return false;
}

// Codex's key hints are items of the form "<key> to <what it does>" — "tab to
// add notes", "⌃x enter to submit answer", "tab or esc to clear notes", "←/→ to
// navigate questions" — joined by " | ", sometimes after an "option 4/5"
// position, and it wraps them between items when the pane is too narrow for one
// line. A multi-question form's hints run to about 90 columns, so a Herdr split
// narrower than that put "tab to add notes | enter to submit answer" on a line
// of its own, without the "esc to" that made the full line chrome. Read as
// content below the choices, it turned a live form into one merely quoted, and
// the ping was skipped. Every item has to name a key, so prose that happens to
// say "to submit" is not taken for one.
//
// The shape alone is not enough, though: a choice's description can read the
// same ("Return to the previous screen" under "2. Go back"). So this is not a
// chrome rule. Only `isFooterAt` uses it, for lines below the last choice.
const HINT_KEY =
  "(?:[⌃⌥⇧⌘]\\S{1,8}|(?:ctrl|alt|shift|cmd|opt)\\+\\S{1,8}|enter|esc|escape|tab|space|return|backspace|delete|home|end|pgup|pgdn|f\\d{1,2}|[←→↑↓](?:\\/[←→↑↓])?|[a-z])";
const HINT_KEYS = `${HINT_KEY}(?:\\s+${HINT_KEY})?`;
const KEY_TIP = new RegExp(
  `^(?:${HINT_KEYS}(?:\\s+(?:or|\\/)\\s+${HINT_KEYS})?\\s+(?:to\\s+[a-z][\\w/ -]*|change question)|option \\d+\\/\\d+)$`,
  "i",
);

function isKeyTipLine(text) {
  if (text.length >= 120) {
    return false;
  }
  return text.split(/\s+\|\s+/).every((item) => KEY_TIP.test(item.trim()));
}

// Chrome as the trailing walk sees it: the lines under the last choice, read
// from the bottom up. Everything `isChromeLine` takes, plus two shapes that
// are footer only because of where they sit:
//
// - a Codex key-hint line, in a block of its own (a blank line or a rule above
//   it, nothing in it but hints and chrome);
// - the rest of a hint the terminal wrapped mid-sentence. Codex's "Press enter
//   to confirm or esc to cancel" is 43 columns with its indent; narrower than
//   that it breaks after "to" and leaves "cancel" alone underneath, and that
//   one word was content below the choices — no live dialog, no ping. A hint
//   never ends on "to" or "or", so one that does was cut, and the few words
//   right under it are the rest of it.
//
// Both must also sit no deeper than the last choice's number. Footers are
// drawn at the dialog's margin; a choice's description and a wrapped label hang
// deeper, and must stay content however much they read like a hint.
function isFooterAt(lines, i) {
  if (isChromeLine(lines[i])) {
    return true;
  }
  if (!atFooterColumn(lines, i)) {
    return false;
  }
  if (isKeyTipLine(lines[i].trim()) && inFooterBlock(lines, i)) {
    return true;
  }
  const above = lines[i - 1];
  return (
    above !== undefined &&
    !isBlank(above) &&
    /\s(?:to|or|and)$|\s[|·]$/.test(above.trim()) &&
    /^\S+(?:\s+\S+){0,2}$/.test(lines[i].trim()) &&
    isFooterAt(lines, i - 1)
  );
}

// No deeper than the number of the nearest choice above, if there is one.
function atFooterColumn(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (isOptionLine(lines[j])) {
      return indentOf(lines[i]) <= lines[j].search(/\d/);
    }
  }
  return true;
}

// The block of lines around `i` (between blank lines or rules) starts after
// one, and holds nothing but hints and chrome.
function inFooterBlock(lines, i) {
  const boundary = (line) => isBlank(line) || isRuleLine(line);
  let top = i;
  while (top > 0 && !boundary(lines[top - 1])) {
    top--;
  }
  if (top === 0) {
    return false;
  }
  for (let j = top; j < lines.length && !boundary(lines[j]); j++) {
    if (!isChromeLine(lines[j]) && !isKeyTipLine(lines[j].trim())) {
      return false;
    }
  }
  return true;
}

function isUserMarker(line) {
  const text = line.trim();
  if (/^(you|user|human)\s*[:：]/i.test(text)) {
    return true;
  }
  if (/^[❯›▸]\s+\S/.test(text)) {
    return true;
  }
  return false;
}

function capSnippet(text) {
  if (text.length <= 3200) {
    return text;
  }
  let slice = text.slice(-3200);
  const nl = slice.indexOf("\n");
  if (nl > 0 && nl < 200) {
    slice = slice.slice(nl + 1);
  }
  return slice.trim();
}

function cleanOptionLine(raw) {
  return stripAnsi(raw)
    .replace(/[\u2500-\u257F]/g, " ")
    .replace(/^[^\w\d(]*?(?=\d{1,2}[.)、])/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Put an option back together after the terminal wrapped it. A long choice is
// set across two lines with a hanging indent — "…for this session" and then
// "(shift+tab)" alone underneath — and reading only the numbered line drops
// whatever landed on the tail. Joining is also what makes the wrapped form
// behave like the inline one: the trailing parenthetical is weighed as a
// shortcut, or kept as prose, on the same terms either way, and the label stops
// changing when the pane is resized and the wrap moves. Only the agent's own
// hanging indent gets here — a hard wrap at column 0 is left of the option
// column, so `trailingOptionRun` never admits it — which is why the pieces join
// on a word boundary with a single space.
//
// A form's choices carry a description on the lines under them, at that same
// hanging indent, and joining those too is what put "Drop it (Recommended) A
// failed send gets Home's per-message r…" on a button. Indentation cannot tell
// the two apart; the width can. A wrap leaves the line above it full, and a
// description starts under a label with room to spare. So each row has a
// `label` — the numbered line and what wrapped off it — and a `text`, which is
// everything the option says, description included.
function joinWrappedOptions(lines, width) {
  const rows = [];
  let previous;
  let wrapping = false;
  for (const raw of lines) {
    // A form draws a divider between two sections of its choice list. Rules
    // survive `cleanOptionLine` when they carry a caption, and gluing one onto
    // the option above it would put the caption on a button.
    if (isRuleLine(raw)) {
      continue;
    }
    const line = cleanOptionLine(raw);
    if (!line) {
      continue;
    }
    if (/^\d{1,2}[.)、]\s+\S/.test(line)) {
      rows.push({ label: line, text: line });
      previous = raw;
      wrapping = true;
      continue;
    }
    if (!rows.length) {
      continue;
    }
    const row = rows[rows.length - 1];
    row.text += ` ${line}`;
    // Once a description has begun, the rest of the lines under this option are
    // the description and its own wraps.
    if (wrapping && wrappedOnto(previous, raw, width)) {
      row.label += ` ${line}`;
      previous = raw;
    } else {
      wrapping = false;
    }
  }
  return rows;
}

// Widths are counted, not measured: an ambiguous glyph or an emoji can be off
// by a column, so a line this close to the edge still counts as full.
const WRAP_SLACK = 2;

// Did the terminal carry `next` over from `previous`? A word moves down only
// when it does not fit, so after a wrap the line above, a space, and the word
// that was carried over together overrun the pane.
function wrappedOnto(previous, next, width) {
  const word = String(next).trim().split(/\s+/)[0] ?? "";
  return displayWidth(previous) + 1 + displayWidth(word) > width - WRAP_SLACK;
}

// How wide the pane is, read off the screen itself: the rules the agents draw
// run the full width, and no line can be wider than the pane.
function screenWidth(lines) {
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, displayWidth(line));
  }
  return width;
}

// Columns a line takes on the terminal. CJK and fullwidth text take two per
// character, and a pane of Chinese reads half as wide as its string length.
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += isWideCodePoint(ch.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

function isWideCodePoint(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

// A trailing parenthetical comes off the text only when it names a keystroke.
// "(default)" and "(shift+tab)" are prose the user should still read, and typing
// them into the pane is what a stripped non-shortcut used to do.
function splitShortcut(raw) {
  const text = String(raw).replace(/\s+/g, " ").trim();
  const trailing = text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const shortcut = trailing ? normalizeShortcut(trailing[2]) : undefined;
  return shortcut ? { text: trailing[1].trim(), shortcut } : { text };
}

export function parseBlockedOptions(screen) {
  return readOptions(screen).map(({ key, send, label, multi, cursor, submitOnly }) => ({
    key,
    send,
    label,
    ...(multi ? { multi: true, cursor } : {}),
    ...(submitOnly ? { submitOnly: true } : {}),
  }));
}

// The choices, each with its button `label` and its `whole` text — the label
// plus any description, which is what the fingerprint hashes.
function readOptions(screen) {
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  if (region?.omp) {
    // A form that has advanced to its note field has no choices left, but it
    // still needs a card: the input and Submit are the only way to finish it.
    return region.options.length
      ? region.options
      : [{
          key: "1",
          send: "keys:enter",
          label: "直接提交",
          whole: "直接提交",
          submitOnly: true,
        }];
  }
  // Only the choices under this question. Numbered lines elsewhere on screen
  // are earlier chat messages, not options.
  const candidates =
    region?.optionStart === undefined ? [] : lines.slice(region.optionStart, region.end);
  const options = [];
  const seen = new Set();
  for (const row of joinWrappedOptions(candidates, screenWidth(lines))) {
    const numbered = row.label.match(/^(\d{1,2})[.)、]\s+(.+)$/);
    if (!numbered) {
      continue;
    }
    const index = numbered[1];
    const own = splitShortcut(numbered[2]);
    const send = own.shortcut || index;
    if (seen.has(send) || seen.has(`i:${index}`)) {
      continue;
    }
    seen.add(send);
    seen.add(`i:${index}`);
    // Bounded by the widest thing that renders a label: the desktop panel, at
    // 96 for "<key>. <label>" (`panelLabels`). Telegram caps its own button at
    // 64. The old 72 predated rejoining wrapped options and cut a real choice
    // mid-word — "…for this sessio" — as soon as the tail was added back.
    options.push({
      key: index,
      send,
      label: own.text.slice(0, 96),
      whole: splitShortcut(row.text.replace(/^\d{1,2}[.)、]\s+/, "")).text,
    });
  }
  if (options.length) {
    return options.slice(0, 9);
  }
  if (/\b\[?y\/n\]?\b/i.test(screen) || /\(y\/n\)/i.test(screen)) {
    return [
      { key: "y", send: "y", label: "yes", whole: "yes" },
      { key: "n", send: "n", label: "no", whole: "no" },
    ];
  }
  return [];
}

// OMP's select/dropdown control draws one option at a time:
//   │ ‹ 家附近转转，半天来回 ›  1/4
// Left/right change the selection; Enter advances. The full option list is in
// the agent's ask call, not on screen (see ompSelectOptions in transcript.mjs).
export function parseOmpDropdown(screen) {
  const lines = screenLines(screen);
  const region = ompFormRegion(lines);
  if (!region?.omp) {
    return undefined;
  }
  for (let i = region.start; i < region.end; i++) {
    const inner = ompInnerText(lines[i]);
    const match = /‹\s*(.+?)\s*›\s*(\d+)\s*\/\s*(\d+)/u.exec(inner);
    if (match) {
      return {
        label: match[1].trim(),
        current: Number(match[2]),
        total: Number(match[3]),
      };
    }
  }
  return undefined;
}

// The one gate for every set of buttons we offer, Telegram and desktop panel
// alike. A hook-authoritative block has no menu drawn at all, so the y/n
// fallback above would happily put buttons on an agent that is waiting for free
// text — and a tap would send a keystroke it never asked for.
export function dialogChoices(screen, { hookAuthoritative = false, selectOptions } = {}) {
  if (hookAuthoritative) {
    return [];
  }
  const dropdown = selectOptions && parseOmpDropdown(screen);
  if (dropdown && selectOptions.labels?.length) {
    const current = Math.max(0, Math.min(dropdown.current - 1, selectOptions.labels.length - 1));
    return selectOptions.labels.slice(0, 9).map((label, index) => {
      const keys = [];
      for (let step = 0; step < Math.abs(index - current); step++) {
        keys.push(index > current ? "right" : "left");
      }
      keys.push("enter");
      return {
        key: String(index + 1),
        send: `keys:${keys.join(",")}`,
        label: label.slice(0, 96),
        whole: label,
      };
    });
  }
  return parseBlockedOptions(screen);
}

// A trailing parenthetical is a keystroke only when it names one. The old
// "alphanumeric and short" rule turned "1. Yes (default)" into the key
// sequence "default", which the reply path types into the pane as text.
const NAMED_SHORTCUTS = {
  esc: "esc",
  escape: "esc",
  enter: "enter",
  return: "enter",
  tab: "tab",
  space: "space",
};

function normalizeShortcut(raw) {
  const text = String(raw || "")
    .trim()
    .toLowerCase();
  if (!text) {
    return undefined;
  }
  if (NAMED_SHORTCUTS[text]) {
    return NAMED_SHORTCUTS[text];
  }
  if (/^[a-z0-9]$/.test(text)) {
    return text;
  }
  return undefined;
}

// What this dialog is asking, condensed to a stable id: the question plus the
// choices, nothing else. The inbound path compares it against the live screen
// before pressing a key, so a button tapped minutes late cannot answer whatever
// dialog happens to be up now. Spinners and footers sit outside the region, so
// two reads of an unchanged dialog hash the same.
export function dialogFingerprint(screen) {
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  if (!region) {
    return undefined;
  }
  const parts = [collapse(region.header >= 0 ? lines[region.header] : "")];
  // Everything each option says, description included — not the button label.
  // Where a label ends and its description begins is judged against the pane
  // width read off the screen, and a hash must not move with that reading; the
  // description is also part of what the user is agreeing to. For a choice with
  // no description the two are the same text, so those hash as they always did.
  for (const option of readOptions(screen)) {
    parts.push(`${option.key}|${collapse(option.whole)}`);
  }
  // The body too, but only down to the first option: two Bash approvals in a
  // row ask the identical question with the identical choices, and only the
  // command tells "delete the draft" from "force-push to main". The option
  // lines themselves are already hashed as `key|label`, and re-hashing them raw
  // would move the fingerprint every time the terminal's selection marker does.
  parts.push(collapse(renderBlock(lines.slice(region.start, region.optionStart ?? region.end))));
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function collapse(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function optionKeyboard(options) {
  if (!options?.length) {
    return undefined;
  }
  return {
    inline_keyboard: options.map((option) => [
      {
        text: `${option.key}. ${option.label}`.slice(0, 64),
        callback_data: String(option.send || option.key).slice(0, 32),
      },
    ]),
  };
}

export function formatMessage(context, event, status, snippet) {
  return composeMessage(statusTitle(context, event, status), formatWhere(context, event), status, snippet);
}

// The line a blocked ping ends with. A Feishu card swaps it for its own wording,
// and drops it once a button has been pressed.
export const BLOCKED_HINT = "tap a button, or type another answer";

// The message once its title and location are known. The poller follows a form
// without the event the hook was handed, so it builds each next ping from what
// the first one recorded.
export function composeMessage(head, where, status, snippet) {
  if (status === "blocked") {
    const body = snippet || "waiting for input";
    return [head, where, "", body, "", BLOCKED_HINT].join("\n");
  }
  if (status === "done" || status === "finish") {
    return [head, where, "", snippet || "finished"].join("\n");
  }
  return [head, where, "", status].join("\n");
}

export function statusTitle(context = {}, event = {}, status = "") {
  return `${status} · ${agentLabel(context, event)}`;
}

export function formatWhere(context = {}, event = {}) {
  const repo = repoName(context, event);
  const worktree = worktreeFrom(context, event);
  const worktreeText = worktreeLabel(worktree);
  const worktreeShort = worktreeShortName(worktree);
  const space = spaceName(context, event);
  const tab = namedTabLabel(context.tab_label ?? event?.data?.tab_label);
  const pane = paneOrdinal(paneIdFrom(event, context));
  const parts = [];
  if (repo) {
    parts.push(repo);
  }
  if (worktreeText) {
    parts.push(worktreeText);
  }
  if (space && !equalsFold(space, repo) && !equalsFold(space, worktreeShort)) {
    parts.push(space);
  }
  if (tab) {
    parts.push(tab);
  }
  if (pane) {
    parts.push(`pane ${pane}`);
  }
  return parts.join(" · ") || paneIdFrom(event, context) || "workspace";
}

function repoName(context, event) {
  const worktree = context.worktree ?? event?.data?.worktree ?? {};
  return firstString(
    worktree.repo_name,
    worktree.repoName,
    pathBasename(worktree.repo_root),
    pathBasename(worktree.checkout_path),
  );
}

function spaceName(context, event) {
  const id = firstString(context.workspace_id, event?.data?.workspace_id);
  const label = firstString(
    context.workspace_label,
    event?.data?.workspace_label,
    event?.data?.workspace_name,
  );
  if (label && label !== id && !isOpaqueWorkspaceId(label)) {
    return label;
  }
  const cwd = firstString(
    context.workspace_cwd,
    context.focused_pane_cwd,
    event?.data?.cwd,
    event?.data?.workspace_cwd,
  );
  const fromCwd = pathBasename(cwd);
  if (fromCwd && fromCwd !== id && !isOpaqueWorkspaceId(fromCwd)) {
    return fromCwd;
  }
  if (label && !isOpaqueWorkspaceId(label)) {
    return label;
  }
  return undefined;
}

function paneOrdinal(paneId) {
  const match = String(paneId).match(/:p([0-9A-Za-z]+)$/i);
  return match ? match[1] : undefined;
}

function isOpaqueWorkspaceId(text) {
  return /^w[0-9A-Za-z]{1,3}$/.test(String(text));
}

function pathBasename(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const name = basename(value.trim().replace(/[\\/]+$/, ""));
  return name && name !== "." && name !== ".git" ? name : undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function equalsFold(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function agentLabel(context, event) {
  const raw =
    event?.data?.display_agent ??
    event?.data?.agent ??
    context.focused_pane_agent ??
    context.agent ??
    "agent";
  return titleCase(raw);
}

function namedTabLabel(label) {
  const text = String(label ?? "").trim();
  if (!text || /^\d+$/.test(text)) {
    return undefined;
  }
  return text;
}

function titleCase(value) {
  const text = String(value).trim();
  if (!text) {
    return "Agent";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
