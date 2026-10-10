import assert from "node:assert/strict";
import test from "node:test";
import finishExtension, {
  buildFinishPrompt, FINISH_PROMPT, VERIFICATION_PROMPT, NORMAL_INSTRUCTIONS, COMMIT_INSTRUCTIONS,
} from "./index.ts";

function harness(idle, hasUI = true) {
  const commands = new Map();
  const messages = [];
  const notices = [];
  finishExtension({
    registerCommand(name, command) { commands.set(name, command); },
    sendUserMessage(...args) { messages.push(args); },
  });
  const ctx = {
    isIdle: () => idle,
    hasUI,
    ui: { notify(...args) { notices.push(args); } },
  };
  return { commands, messages, notices, ctx };
}

test("/finish starts a verification turn when idle", async () => {
  const h = harness(true);
  await h.commands.get("finish").handler("", h.ctx);
  assert.deepEqual(h.messages, [[FINISH_PROMPT]]);
  assert.equal(h.notices.length, 0);
});

test("busy agent receives a follow-up, not steering", async () => {
  const h = harness(false);
  await h.commands.get("finish").handler(" backend tests ", h.ctx);
  assert.deepEqual(h.messages, [[buildFinishPrompt("backend tests"), { deliverAs: "followUp" }]]);
  assert.equal(h.notices.length, 1);
});

test("busy non-UI context queues without notifications", async () => {
  const h = harness(false, false);
  h.ctx.ui = undefined;
  await h.commands.get("finish").handler(undefined, h.ctx);
  assert.equal(h.messages.length, 1);
  assert.equal(h.notices.length, 0);
});

test("focus is trimmed and blank focus uses the base instructions", () => {
  assert.equal(buildFinishPrompt(" \n "), FINISH_PROMPT);
  assert.ok(buildFinishPrompt(" frontend ").endsWith("\nfrontend"));
});

test("commit mode is explicit and retains verification requirements", () => {
  for (const args of ["commit", " COMMIT ", "commit\nbackend"]) {
    const prompt = buildFinishPrompt(args);
    assert.match(prompt, /Automatic commit mode/);
    assert.match(prompt, /Do not ask for another intent confirmation/);
    assert.match(prompt, /Failed, skipped, timed-out, or unverified requirements block committing/);
    assert.match(prompt, /unrelated changes are staged/);
    assert.match(prompt, /git diff --cached --check/);
    assert.match(prompt, /actual commit hash, message, and remaining Git status/);
    assert.match(prompt, /"gate".*case-insensitive/);
    assert.ok(prompt.startsWith(VERIFICATION_PROMPT));
    assert.ok(prompt.includes(COMMIT_INSTRUCTIONS));
    assert.ok(!prompt.includes(NORMAL_INSTRUCTIONS));
  }
  assert.ok(buildFinishPrompt("commit backend").endsWith("\nbackend"));
  assert.doesNotMatch(buildFinishPrompt("commitment review"), /Automatic commit mode/);
  assert.doesNotMatch(buildFinishPrompt("focus on commit"), /Automatic commit mode/);
});

test("/finish commit sends the commit workflow through normal agent delivery", async () => {
  const h = harness(true);
  await h.commands.get("finish").handler("commit", h.ctx);
  assert.deepEqual(h.messages, [[buildFinishPrompt("commit")]]);
});

test("workflow includes documented gates and safety/reporting instructions", () => {
  assert.match(FINISH_PROMPT, /Search.*documentation.*"gate".*case-insensitive/);
  assert.match(FINISH_PROMPT, /unmet or unverified gate/);
  assert.match(FINISH_PROMPT, /Do not edit source/);
  assert.match(FINISH_PROMPT, /Do not stage, commit/);
  assert.equal(FINISH_PROMPT, `${VERIFICATION_PROMPT}\n\n${NORMAL_INSTRUCTIONS}`);
  assert.match(FINISH_PROMPT, /PASS\/FAIL\/SKIPPED\/TIMED OUT/);
  assert.match(FINISH_PROMPT, /do not initialize Git/);
  assert.match(FINISH_PROMPT, /Respect tool permissions and plan-mode restrictions; never bypass them/);
});
