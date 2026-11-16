import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIND, LOG, Conversation, records, resultText, pilotLine, sendsOf } from "./chat-log.js";

// A Claude Code log as LOG reads it, fed to a Conversation.
async function read(lines) {
  const dir = mkdtempSync(join(tmpdir(), "chat-log-"));
  const f = join(dir, "log.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const p = Bun.spawn(["sh", "-c", LOG, "log", "tail", f, "0"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  rmSync(dir, { recursive: true });
  const c = new Conversation("claude");
  c.feed(records(out).records);
  return c;
}
const said = (c) => c.items.filter((x) => x.kind === "agent").map((x) => x.text);

// Lines as Claude Code 2.1.314 writes them (from real logs: their keys in its order, the signatures' real starts).
const at = "2026-11-04T15:50:49.652Z";
let n = 0;
const reply = (id, content, more = {}) => ({ parentUuid: null, isSidechain: false,
  message: { model: "claude-opus-5-5", id, type: "message", role: "assistant", content, stop_reason: "tool_use" },
  ...more, type: "assistant", uuid: `u${n++}`, timestamp: at });
const THINKING = "CAQSjA4KEAgTGAI4AUIIdGhpbmtpbmcSDM9K0ZnYDV50j17EHBoM";   // decodes to ...B\bthinking
const NARRATION = "CAQSpQkKEQgTGAI4AUIJbmFycmF0aW9uEgz6cN5kl8wh1Z7YUzIa"; // decodes to ...B\tnarration
const thinking = (words, signature = THINKING) => ({ type: "thinking", thinking: words, signature });
const text = (words) => ({ type: "text", text: words });
const call = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" }, caller: { type: "direct" } };
const person = { parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: "Test bubble for reactions" }, uuid: "p1", timestamp: at };

test("a message Claude Code shows as an update (its long words cut short) is the agent's message", async () => {
  // the terminal shows this update in place of what the agent wrote: the chat shows it too
  const update = "The web \"before\" shot shows the pills floating mid-row, so I'm writing a long test message to react to.\n\n";
  const c = await read([
    person,
    reply("m1", [thinking("")], { thinkingDisplay: "updates", apiBlockIndex: 0 }),
    reply("m1", [thinking(update, NARRATION)], { thinkingDisplay: "updates", apiBlockIndex: 1 }),
    reply("m1", [call], { apiBlockIndex: 2 }),
  ]);
  expect(said(c)).toEqual([update.trim()]);
});

test("an update on one line with the call it comes before: its signature says so", async () => {
  // a real case: no thinkingDisplay on the line; only the signature tells the update from thinking
  const c = await read([reply("m2", [thinking(""), thinking("Claude found a separate bug in the web chat.\n\n", NARRATION), call])]);
  expect(said(c)).toEqual(["Claude found a separate bug in the web chat."]);
});

test("thinking stays hidden: empty, or summarized", async () => {
  const c = await read([
    reply("m3", [thinking("")], { thinkingDisplay: "updates" }),
    reply("m4", [thinking("Just a simple greeting, so I'll keep my reply short.\n\n")], { thinkingDisplay: "summarized" }),
    reply("m5", [thinking("A thought in a line of its own.")]),
  ]);
  expect(said(c)).toEqual([]);
  expect(c.doing).toBe("Thinking");
});

test("an update and the words after it in one reply are one message", async () => {
  const c = await read([
    reply("m6", [thinking("Checking the log first.\n\n", NARRATION)], { thinkingDisplay: "updates" }),
    reply("m6", [text("Found it: the update is a thinking block.")]),
  ]);
  expect(said(c)).toEqual(["Checking the log first.\n\nFound it: the update is a thinking block."]);
});

test("a reply's react lines land on the person's message, at its start, middle or end", async () => {
  const long = [
    '<hc react="👀" to="Test bubble for reactions"/>',
    "First paragraph of a long reply.",
    "",
    "- a list item with `code`",
    "- another",
    '<hc react="🔥" to="Test bubble"/>',
    "```js",
    "const a = 1;",
    "```",
    "",
    "Last paragraph.",
    '<hc react="✅" to="Test bubble for reactions"/>',
  ].join("\n");
  const c = await read([person, reply("m7", [text(long)])]);
  expect(said(c)).toEqual(["First paragraph of a long reply.\n\n- a list item with `code`\n- another\n```js\nconst a = 1;\n```\n\nLast paragraph."]);
  expect(c.reactions.get(c.items[0].id).map((r) => r.emoji)).toEqual(["👀", "🔥", "✅"]);
});

// SHEP-47: the person's words in to= may hold double quotes; the line still reacts and never shows.
test("a react line whose to= quotes the person's \"words\" still reacts", async () => {
  const mac = { ...person, uuid: "p4", message: { role: "user", content: 'aha well "this machine" is my mac mini' } };
  const reply1 = '<hc react="💡" to="aha well "this machine" is my mac mini"/>\nGot it: the Mac mini is this machine.';
  const c = await read([mac, reply("m1", [text(reply1)])]);
  expect(said(c)).toEqual(["Got it: the Mac mini is this machine."]);
  expect(c.reactions.get(c.items[0].id)).toEqual([{ emoji: "💡", by: "agent" }]);
});

test("a to= with its quotes dropped or made curly still names the message", async () => {
  const mac = { ...person, uuid: "p4", message: { role: "user", content: 'aha well "this machine" is my mac mini' } };
  for (const to of ["aha well this machine is my mac mini", "aha well “this machine” is my mac mini"]) {
    const c = await read([mac, reply("m1", [text(`<hc react="💡" to="${to}"/>\nGot it.`)])]);
    expect(said(c)).toEqual(["Got it."]);
    expect(c.reactions.get(c.items[0].id)).toEqual([{ emoji: "💡", by: "agent" }]);
  }
});

test("a react tag with to= first, at a paragraph's start, still reacts", async () => {
  const c = await read([person, reply("m1", [text('<hc to="Test bubble" react="👍"/> Rest.')])]);
  expect(said(c)).toEqual(["Rest."]);
  expect(c.reactions.get(c.items[0].id)).toEqual([{ emoji: "👍", by: "agent" }]);
});

test("emoji with variation selectors and skin tones react", async () => {
  for (const emoji of ["💡", "❤️", "👍🏽", "👨‍👩‍👧"]) {
    const c = await read([person, reply("m1", [text(`<hc react="${emoji}" to="Test bubble"/>\nOk.`)])]);
    expect(said(c)).toEqual(["Ok."]);
    expect(c.reactions.get(c.items[0].id)).toEqual([{ emoji, by: "agent" }]);
  }
});

test("a react tag at the start of a paragraph reacts and leaves its words", async () => {
  const words = 'First.\n\n<hc react="👍" to="Test bubble for"/> Then the rest.';
  const c = await read([person, reply("m1", [text(words)])]);
  expect(said(c)).toEqual(["First.\n\nThen the rest."]);
  expect(c.reactions.get(c.items[0].id)).toEqual([{ emoji: "👍", by: "agent" }]);
});

test("a react line that can't be read never shows as text", async () => {
  for (const line of ['<hc react="👀" to="unclosed', '<hc react=👀 to=x/>']) {
    const c = await read([person, reply("m1", [text(`${line}\nStill here.`)])]);
    expect(said(c)).toEqual(["Still here."]);
  }
});

// SHEP-42: a reply that is only a reaction (Settings › Reactions) shows just that reaction on the person's message.
test("a react line with <hc no-reply/> shows only the reaction", async () => {
  const thanks = { ...person, uuid: "p2", message: { role: "user", content: "Thanks, that's perfect" } };
  for (const words of ['<hc react="🙏" to="Thanks, that\'s perfect"/>\n<hc no-reply/>', '<hc no-reply/>\n<hc react="🙏" to="Thanks"/>']) {
    const c = await read([person, reply("m1", [text("Done: the card is bigger now.")]), thanks, reply("m2", [text(words)])]);
    expect(said(c)).toEqual(["Done: the card is bigger now."]);
    const you = c.items.filter((x) => x.kind === "user");
    expect(c.reactions.get(you[1].id)).toEqual([{ emoji: "🙏", by: "agent" }]);
    expect(c.reactions.get(you[0].id)).toBeUndefined();
    expect(c.items.at(-1).kind).toBe("user");
  }
});

// A running Assistant told Reactions changed (herdr-task's <herdr-setting>): nothing of it shows, nor its no-reply.
test("a Reactions change told to the Assistant shows nothing", async () => {
  const note = { ...person, uuid: "p3", message: { role: "user", content: '<herdr-setting name="reactions" value="off">Reactions are now off in Settings: don\'t react (no <hc react> lines). Nothing to answer: reply only <hc no-reply/>.</herdr-setting>' } };
  const c = await read([person, note, reply("m3", [text("<hc no-reply/>")])]);
  expect(c.items.map((x) => x.kind)).toEqual(["user"]);
  expect(c.items[0].text).toBe("Test bubble for reactions");
});

// SHEP-49: several settings changed at once, one <herdr-setting> line each in one message: nothing shows.
test("a settings notice of several lines shows nothing", async () => {
  const content = '<herdr-setting name="review" value="on" scope="everywhere">Review is now on, at most 3 rounds; your setting everywhere. Tasks you add from now on get it; running ones keep their brief.</herdr-setting>\n' +
    '<herdr-setting name="merge" value="auto" scope="space">Merge is now on its own (Herdr merges a ready task); set for this space. Tasks you add from now on get it; running ones keep their brief. Nothing to answer: reply only <hc no-reply/>.</herdr-setting>';
  const c = await read([person, { ...person, uuid: "p4", message: { role: "user", content } }, reply("m4", [text("<hc no-reply/>")])]);
  expect(c.items.map((x) => x.kind)).toEqual(["user"]);
});

// SHEP-5: an Autopilot wake as herdr-task sends it (as tor-gameboy's Assistant got it: the CLI wraps it as pasted).
const wake = (reason, uuid = "w1") => ({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user",
  content: `\n\n<pasted_content id="4f83">\n<herdr-autopilot reason="${reason}" space="sp5">\nAutopilot wake: ${reason}, Thu 06:30.\nYou are on Autopilot…\n</herdr-autopilot>\n</pasted_content>` }, uuid, timestamp: at });
const lines = (c) => c.items.filter((x) => x.kind === "pilot").map(pilotLine);

test("an Autopilot wake shows as one quiet line, never silence, and its words never show", async () => {
  // it looked, then had nothing to say (the tor-gameboy wake that showed nothing)
  let c = await read([wake("schedule"), reply("m1", [call]), reply("m2", [text("<hc no-reply/>")])]);
  expect(lines(c)).toEqual(["Autopilot woke · on schedule · checked, nothing new"]);
  expect(c.items.some((x) => x.kind === "user")).toBe(false);
  expect(said(c)).toEqual([]);
  // nothing to do at all
  c = await read([wake("run now"), reply("m1", [text("<no-reply>")])]);
  expect(lines(c)).toEqual(["Autopilot woke · Run now · nothing to do"]);
  // it said something: its message follows the line
  c = await read([wake("event:ready HAT-4"), reply("m1", [text("HAT-4 looks right to Accept.")])]);
  expect(lines(c)).toEqual(["Autopilot woke · HAT-4 is ready"]);
  expect(said(c)).toEqual(["HAT-4 looks right to Accept."]);
  // still at work: the line alone; a later no-reply to task news isn't the wake's
  c = await read([wake("switched on"), reply("m1", [call])]);
  expect(lines(c)).toEqual(["Autopilot woke · switched on"]);
  c = await read([wake("schedule"), reply("m1", [text("Started HAT-5.")]), person, reply("m2", [text("<hc no-reply/>")])]);
  expect(lines(c)).toEqual(["Autopilot woke · on schedule"]);
  // SHEP-40: a quiet wake says why on its line, never a bare "nothing to do"
  c = await read([wake("schedule"), reply("m1", [call]), reply("m2", [text('<hc no-reply why="Checked TG-2: waiting on your Accept; TG-3 and TG-4 wait behind it"/>')])]);
  expect(lines(c)).toEqual(["Autopilot woke · on schedule · Checked TG-2: waiting on your Accept; TG-3 and TG-4 wait behind it"]);
  expect(said(c)).toEqual([]);
  c = await read([wake("run now"), reply("m1", [text(`<hc no-reply why="${"x".repeat(300)}"/>`)])]);
  expect(lines(c)[0].length).toBeLessThan(200);
  expect(said(c)).toEqual([]);
});

// Agent to agent as a group chat (SHEP-27): another Assistant's message, and the messages this agent sends.
const told = (content, uuid = "h1") => ({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content }, uuid, timestamp: at });
const bash = (id, command) => ({ type: "tool_use", id, name: "Bash", input: { command }, caller: { type: "direct" } });

test("another Assistant's message (tell-assistant) is a message from it, its machine and space kept", async () => {
  const c = await read([told('\n\n<pasted_content id="6418">\n<herdr-assistant from="mac/t13" machine="mac" space="Home" can-reply="no">From the Mac mini: a bug &amp; more</herdr-assistant>\n</pasted_content>')]);
  const u = c.items.find((x) => x.kind === "user");
  expect(u.from).toBe("mac/t13");
  expect(u.assistant).toEqual({ machine: "mac", space: "Home", reply: false });
  expect(u.text).toBe("From the Mac mini: a bug &amp; more");
  // a brief that only quotes the tag among other words stays the person's
  const q = await read([told('Show <herdr-assistant from="a/t1" machine="a" space="S">x</herdr-assistant> like this')]);
  expect(q.items.find((x) => x.kind === "user")?.from).toBeUndefined();
});

test("what the agent sends other agents (hc send, tell-assistant) is a message of its own after its call", async () => {
  const c = await read([person, reply("m1", [bash("toolu_s1", 'export PATH=~/.local/bin:$PATH; M="Rebase on main"; hc send t10v "$M" >/dev/null; hc send --force t10s "$M" >/dev/null 2>&1 || hc send t10s "$M"; echo ok'),
    bash("toolu_s2", "herdr-task tell-assistant mac/t13 'Thanks, on it' --json")])]);
  const sent = c.items.filter((x) => x.kind === "sent").map((x) => [x.to, x.text, x.how]);
  // the retry after || shows once
  expect(sent).toEqual([["t10v", "Rebase on main", "hc"], ["t10s", "Rebase on main", "hc"], ["mac/t13", "Thanks, on it", "assistant"]]);
  expect(c.items.findIndex((x) => x.kind === "tools")).toBeLessThan(c.items.findIndex((x) => x.kind === "sent"));
});

test("sendsOf reads only what a command really sends", () => {
  // a heredoc's body is a file's words, never a command
  expect(sendsOf("cat > b.md <<'EOF'\nhc send t1 \"no\"\nEOF\nhc send t2 \"yes\"")).toEqual([{ to: "t2", text: "yes", how: "hc" }]);
  expect(sendsOf('hc send --if idle --timeout 30 vm/t3 "a \\"quoted\\" word"')).toEqual([{ to: "vm/t3", text: 'a "quoted" word', how: "hc" }]);
  // a text it can't know, and other hc commands, are left out
  expect(sendsOf('hc send t1 "$UNKNOWN"; hc keys t1 enter; hc read t1')).toEqual([]);
  expect(sendsOf("git grep -n 'hc send' core")).toEqual([]);
});

// SHEP-48: a task worker reacts too (Reactions are for every agent): its react line lands on the person's message in
// its task chat, after its brief and its work, and the Settings notice it got mid-work shows nothing.
test("a task worker's reaction lands on the person's message in its task chat", async () => {
  const brief = { ...person, uuid: "b1", message: { role: "user", content: "You work on one Herdr task.\n\nYour task, SHOP-3:\nMake the card bigger." } };
  const ask = { ...person, uuid: "p4", message: { role: "user", content: "Can you also make it blue?" } };
  const notice = { ...person, uuid: "p5", message: { role: "user", content: '<herdr-setting name="reactions" value="on">Reactions are now on in Settings. React to some of the person\'s messages. Nothing to answer: carry on with what you were doing; if nothing, reply only <hc no-reply/>.</herdr-setting>' } };
  const c = await read([brief, reply("w1", [text("Starting on the card."), call]), notice, ask,
    reply("w2", [text('<hc react="👀" to="Can you also make it blue?"/>\nOn it: blue as well.')])]);
  expect(said(c)).toEqual(["Starting on the card.", "On it: blue as well."]);
  const you = c.items.filter((x) => x.kind === "user");
  expect(you.map((x) => x.text)).toEqual([brief.message.content, "Can you also make it blue?"]);
  expect(c.reactions.get(you[1].id)).toEqual([{ emoji: "👀", by: "agent" }]);
});

// SHEP-69 (#589): an Assistant's first message is its role template (with example <herdr-news> lines in a fence)
// and the person's words: no news comes out of it, and the examples stay in its words.
test("a template's example news lines are words, real news lines are news (#589)", async () => {
  const tpl = readFileSync(join(import.meta.dir, "..", "templates", "assistant.md"), "utf8").split(/^---[ \t]*$/m).slice(2).join("---").trim();
  const first = { ...person, uuid: "f1", message: { role: "user", content: `${tpl}\n\nDecisions: B1 = <yours>.` } };
  const news = { ...person, uuid: "n1", message: { role: "user", content: '<herdr-news task="SHOP-2" event="ready">SHOP-2 is ready: Fix login</herdr-news>' } };
  const github = { ...person, uuid: "g1", message: { role: "user", content: "<herdr-github pr=\"7\">Check failed:\n```\nerror <here>\n```\n</herdr-github>\nAnd look at `<herdr-news>` too" } };
  const c = await read([first, reply("m1", [text("On it.")]), news, github]);
  expect(c.items.map((x) => x.kind)).toEqual(["user", "agent", "news", "user"]);
  expect(c.items[0].text.endsWith("Decisions: B1 = <yours>.")).toBe(true);
  expect(c.items[0].text).toContain('<herdr-news task="HAT-4" event="ready">');
  expect(c.items[2]).toMatchObject({ ref: "SHOP-2", event: "ready" });
  // a real tag holding code is still Herdr's: hidden whole, the words around it shown
  expect(c.items[3].text).toBe("And look at `<herdr-news>` too");
});

// Suggested next message: an <hc suggest="…"/> line last on a reply rides on that reply's item, never shows, and only the
// newest words' suggestion counts (an earlier one never leaks onto a later reply).
test("a reply's suggest line rides on the reply, never shows, and a later reply without one has none", async () => {
  const c = await read([
    person,
    reply("m1", [text('Merge it now?\n<hc suggest="yes, merge it"/>')]),
    reply("m2", [text("Merged.")]),
  ]);
  expect(said(c)).toEqual(["Merge it now?", "Merged."]);
  expect(c.items.filter((x) => x.kind === "agent").map((x) => x.suggest)).toEqual(["yes, merge it", undefined]);
});

test("a suggest line in an earlier block doesn't carry onto a later block's words", async () => {
  const c = await read([person, reply("m1", [text('Done?\n<hc suggest="yes"/>'), { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]), reply("m2", [text("More to do.")])]);
  const agents = c.items.filter((x) => x.kind === "agent");
  expect(agents.map((x) => x.text)).toEqual(["Done?", "More to do."]);
  expect(agents[1].suggest).toBeUndefined();
});

test("an empty suggest line counts as none, and a suggest line inside a code block is just words", async () => {
  const c = await read([person, reply("m1", [text('Ok.\n<hc suggest=""/>')]), reply("m2", [text("Code:\n```\n<hc suggest=\"x\"/>\n```")])]);
  const agents = c.items.filter((x) => x.kind === "agent");
  expect(agents[0].suggest).toBeUndefined();
  expect(agents[1].suggest).toBeUndefined();
  expect(agents[1].text).toContain('<hc suggest="x"/>');
});

// ---- OMP: its own session JSONL (synthetic: invented words, the shape OMP 18.20 writes) -------------------------
// OMP's first line is a fixed 256-byte title slot (255 + "\n"), rewritten in place so byte offsets stay put.
const omp = (id, ts, more) => ({ type: "message", id, parentId: null, timestamp: `2026-11-16T10:00:${String(ts).padStart(2, "0")}.000Z`, ...more });
async function readOmp(lines, kind = "omp") {
  const dir = mkdtempSync(join(tmpdir(), "chat-log-omp-"));
  const f = join(dir, "2026-11-16T10-00-00-000Z_01a1e34c-06f1-7474-b9e5-4f8996e2dfe6.jsonl");
  const title = JSON.stringify({ type: "title", v: 1, title: "Fixture", source: "auto", updatedAt: "2026-11-16T10:00:00.000Z", pad: "x" });
  const slot = title.padEnd(255, " ");
  expect(Buffer.byteLength(slot)).toBe(255);
  writeFileSync(f, slot + "\n" + lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const p = Bun.spawn(["sh", "-c", LOG, "log", "page", f, "999999999999", "50"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  const recs = records(out).records;
  const c = new Conversation(kind);
  c.feed(recs);
  return { c, recs, f, dir };
}

test("an OMP log: its title slot, words, calls, answers and compaction become the chat's items", async () => {
  const { c, recs, f, dir } = await readOmp([
    { type: "session", version: 3, id: "01a1e34c-06f1-7474-b9e5-4f8996e2dfe6", timestamp: "2026-11-16T10:00:00.000Z", cwd: "/tmp/fixture" },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-11-16T10:00:00.500Z", model: "example/go-model" },
    { type: "thinking_level_change", id: "m2", parentId: "m1", timestamp: "2026-11-16T10:00:00.600Z", thinkingLevel: "max", configured: null },
    omp("u1", 1, { message: { role: "user", content: [{ type: "text", text: "Add the parser" }], attribution: "user" } }),
    omp("a1", 2, { message: { role: "assistant", content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "On it." },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "printf a", i: "Print a" } },
      { type: "image", data: "blob:sha256:aa", mimeType: "image/png" },
    ] } }),
    omp("r1", 3, { message: { role: "toolResult", toolCallId: "call_1", toolName: "bash",
      content: [{ type: "text", text: "a\nb" }, { type: "image", data: "blob:sha256:bb", mimeType: "image/png" }], isError: false } }),
    omp("a2", 4, { message: { role: "assistant", content: [
      { type: "toolCall", id: "call_2", name: "ask", arguments: { questions: [{ question: "Go?", options: [{ label: "Yes" }, { label: "No" }] }] } },
    ] } }),
    omp("r2", 5, { message: { role: "toolResult", toolCallId: "call_2", toolName: "ask",
      content: [{ type: "text", text: "User answers:\nGo?: Yes" }] } }),
    { type: "compaction", id: "c1", parentId: "r2", timestamp: "2026-11-16T10:00:06.000Z", summary: "Resume prior conversation. Earlier turns archived." },
  ]);
  // the title slot never becomes a message, and its words are nowhere
  expect(c.items.some((x) => String(x.text ?? "").includes("Fixture"))).toBe(false);
  expect(c.items.find((x) => x.kind === "user").text).toBe("Add the parser");
  expect(c.items.find((x) => x.kind === "agent").text).toBe("On it.");
  expect(c.items.find((x) => x.kind === "ask")).toMatchObject({ text: "Go?\n- Yes\n- No", closed: "answered" });
  expect(c.items.find((x) => x.answer).text).toBe("Go?: Yes");
  expect(c.items.find((x) => x.kind === "compact").text).toContain("Resume prior conversation");
  expect(c.meta).toMatchObject({ model: "example/go-model", effort: "max" });
  // a call and its result: the row, and what it printed only when the row opens
  const row = c.items.find((x) => x.kind === "tools");
  expect(row.steps[0]).toMatchObject({ kind: "run", line: "Print a: printf a" });
  const p = Bun.spawn(["sh", "-c", LOG, "log", "results", f, String(row.steps[0].out)], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  const printed = resultText(out.split("\x1e")[1].replace(/^\d+\n/, "").replace(/\n$/, ""), row.steps[0].id);
  expect(printed).toBe("a\nb\n[image]");
  // images are emptied in what LOG sends: their blobs stay on disk
  expect(recs.some((r) => r.kind === "J" && r.data.includes("blob:sha256"))).toBe(false);
  // a tool result's line is its call id only (no output sent)
  expect(recs.find((r) => r.kind === "R").data).toBe("call_1");
  rmSync(dir, { recursive: true });
});

test("OMP's model and thinking changes drive the line under the box", async () => {
  const { c, dir } = await readOmp([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-11-16T10:00:00.500Z", model: "example/first" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-11-16T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
    { type: "model_change", id: "m2", parentId: "u1", timestamp: "2026-11-16T10:00:02.000Z", model: "example/second" },
    { type: "thinking_level_change", id: "m3", parentId: "m2", timestamp: "2026-11-16T10:00:03.000Z", thinkingLevel: "low" },
  ]);
  expect(c.meta).toMatchObject({ model: "example/second", effort: "low" });
  rmSync(dir, { recursive: true });
});

test("an OMP branch summary that says nothing shows no row", async () => {
  const { c, dir } = await readOmp([
    { type: "branch_summary", id: "b1", parentId: null, timestamp: "2026-11-16T10:00:00.000Z", summary: "" },
  ]);
  expect(c.items).toEqual([]);
  rmSync(dir, { recursive: true });
});

test("FIND finds an OMP agent's log by its cwd's session folder", async () => {
  if (process.platform !== "linux") return; // /proc/<pid>/cwd: the fallback the test drives
  const root = mkdtempSync(join(tmpdir(), "chat-find-omp-"));
  const home = join(root, "home"), cwd = join(root, "work");
  mkdirSync(join(home, ".omp", "agent", "sessions", `-tmp-${root.split("/").pop()}-work`), { recursive: true });
  mkdirSync(cwd);
  const f = join(home, ".omp", "agent", "sessions", `-tmp-${root.split("/").pop()}-work`, "2026-11-16T10-00-00-000Z_01a1e34c-06f1-7474-b9e5-4f8996e2dfe6.jsonl");
  writeFileSync(f, "\n");
  const p = Bun.spawn(["sleep", "10"], { cwd, env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
  try {
    await Bun.sleep(150);
    const r = Bun.spawn(["sh", "-c", FIND, "find", "omp", String(p.pid)], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(r.stdout).text();
    expect(out.trim()).toBe(f);
  } finally {
    p.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
