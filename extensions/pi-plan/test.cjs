const { test } = require('node:test');
const assert = require('node:assert/strict');
const jiti = require('/Users/manooi/.nvm/versions/node/v22.22.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti')(__filename);
const extension = jiti('./index.ts').default;
const { extractPlanSteps } = jiti('./src/planner.ts');
const { checkCommand } = jiti('./src/safety.ts');

function harness() {
  const handlers = {};
  const commands = {};
  const entries = [];
  const messages = [];
  const userMessages = [];
  let refinement;
  let processing = false;
  let tools = ['read', 'bash', 'edit', 'write', 'web_search'];
  let choice = 'Execute the plan';
  const pi = {
    on: (name, handler) => { handlers[name] = handler; },
    registerFlag() {}, registerShortcut() {},
    registerCommand: (name, command) => { commands[name] = command.handler; },
    appendEntry: (type, data) => entries.push({ type: 'custom', customType: type, data: structuredClone(data) }),
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (content, options) => {
      if (processing && !['steer', 'followUp'].includes(options?.deliverAs)) {
        throw new Error('Agent is already processing. Specify streamingBehavior');
      }
      userMessages.push({ content, options });
    },
    getFlag: () => false,
    getActiveTools: () => [...tools], setActiveTools: (names) => { tools = [...names]; },
  };
  const ctx = {
    hasUI: true,
    ui: { theme: { fg: (_, value) => value, strikethrough: (s) => s }, setWidget() {}, setStatus() {}, notify() {}, select: async () => choice, editor: async () => refinement },
    sessionManager: { getBranch: () => entries },
  };
  extension(pi);
  return {
    handlers, commands, entries, messages, userMessages, ctx, tools: () => tools,
    setChoice: (c) => { choice = c; },
    setRefinement: (text) => { refinement = text; },
    setProcessing: (value) => { processing = value; },
  };
}

async function start(h) {
  await h.commands.plan('', h.ctx);
  assert.deepEqual(h.tools(), ['read', 'bash', 'grep', 'find', 'ls']);
  await h.handlers.agent_end({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement the fix in detail.\n2. Verify everything carefully.' }] }] }, h.ctx);
  assert.ok(h.tools().includes('web_search'));
}

const settle = (h, lastText = '') => h.handlers.agent_before_settle({ outcome: 'completed', context: { canContinue: false, contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: lastText }] }] } }, h.ctx);
const done = (h, text) => h.handlers.turn_end({ message: { role: 'assistant', content: [{ type: 'text', text }] } }, h.ctx);

test('preserves complete plan steps without truncation', () => {
  const step = 'Implement a detailed change including regression coverage and full verification for the affected subsystem.';
  assert.equal(extractPlanSteps(`Plan:\n1. ${step}`)[0].text, step);
});

test('restores pre-plan tools and advances unfinished steps with bounded retries', async () => {
  const h = harness();
  await start(h);
  assert.match(h.messages.at(-1).message.content, /2\. Verify everything carefully/);
  assert.equal(settle(h, 'I am blocked; need your input'), undefined);
  assert.equal(settle(h).continue, true);
  assert.equal(settle(h).continue, true);
  assert.equal(settle(h), undefined); // no infinite loop without progress
  await done(h, '[DONE:1]');
  const next = settle(h);
  assert.equal(next.continue, true);
  assert.match(next.entries[0].content, /2\. Verify everything carefully/);
  assert.doesNotMatch(next.entries[0].content, /1\. Implement/);
  await done(h, '[DONE:2]');
  await h.handlers.agent_end({ messages: [] }, h.ctx);
  assert.equal(settle(h), undefined);
  assert.ok(h.tools().includes('web_search'));
});

test('queues plan refinement while agent_end is still processing', async () => {
  const h = harness();
  await h.commands.plan('', h.ctx);
  h.setChoice('Refine the plan');
  h.setRefinement('  Use path-based selection instead.  ');
  h.setProcessing(true);
  await h.handlers.agent_end({ messages: [] }, h.ctx);
  assert.deepEqual(h.userMessages, [{
    content: 'Use path-based selection instead.',
    options: { deliverAs: 'followUp' },
  }]);
  assert.deepEqual(h.tools(), ['read', 'bash', 'grep', 'find', 'ls']);
  assert.match((await h.handlers.before_agent_start()).message.content, /PLAN MODE ACTIVE/);
});

test('cancelled or blank refinement does not queue a message', async () => {
  const h = harness();
  await h.commands.plan('', h.ctx);
  h.setChoice('Refine the plan');
  h.setProcessing(true);
  for (const text of [undefined, '', '   ']) {
    h.setRefinement(text);
    await h.handlers.agent_end({ messages: [] }, h.ctx);
  }
  assert.deepEqual(h.userMessages, []);
});

test('restores prior active tools on manual exit and on session resume', async () => {
  const h = harness();
  await h.commands.plan('', h.ctx);
  await h.commands.plan('', h.ctx);
  assert.ok(h.tools().includes('web_search'));
  await start(h);
  const resume = harness();
  resume.entries.push(...h.entries);
  await resume.handlers.session_start({}, resume.ctx);
  assert.ok(resume.tools().includes('web_search'));
  assert.equal(settle(resume).continue, true);
});

test('plan-mode bash safety allows && chaining but blocks destructive segments', () => {
  // The reported failure: `cd X && find ...` must be allowed.
  assert.equal(checkCommand('cd /home/wit/meysure && find frontend/app/src/store -maxdepth 2 -type f').safe, true);
  // Safe chaining of read-only commands.
  assert.equal(checkCommand('ls -la && find . -name "*.ts"').safe, true);
  assert.equal(checkCommand('pwd && git status').safe, true);
  // A bare & (background job) is still blocked.
  assert.equal(checkCommand('find . &').safe, false);
  // ; and backticks are still blocked.
  assert.equal(checkCommand('echo foo; rm -rf /').safe, false);
  assert.equal(checkCommand('ls `id`').safe, false);
  // Newlines are still blocked.
  assert.equal(checkCommand('git status\nrm -rf /').safe, false);
  // Destructive segment after a safe one must not be masked by chaining.
  assert.equal(checkCommand('grep x && rm -rf /').safe, false);
  assert.equal(checkCommand('cd /tmp && rm -rf *').safe, false);
});
