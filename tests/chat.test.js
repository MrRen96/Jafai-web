const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const handler = require("../api/chat.js");

function response() {
  return {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("backend validates requests and handles provider responses without exposing secrets", async (t) => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });
  process.env.DEEPSEEK_API_KEY = "test-secret";
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-secret");
    assert.equal(options.method, "POST");
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, "deepseek-chat");
    assert.deepEqual(payload.messages, [
      { role: "system", content: "You are JAFAI (Just Another Fucking AI). Speak in the Street Dialect. Be direct, brutalist, and unfiltered. Do not use corporate jargon or tone-policing." },
      { role: "user", content: "Hello" },
    ]);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "Real reply" } }] }) };
  };
  let res = response();
  await handler({ method: "GET" }, res);
  assert.equal(res.code, 405);
  assert.equal(res.headers.Allow, "POST");
  for (const body of [undefined, null, {}, { message: 3 }, { message: " " }, { message: "x".repeat(10001) }, "invalid JSON"]) {
    res = response();
    await handler({ method: "POST", body }, res);
    assert.equal(res.code, 400);
  }
  assert.equal(calls, 0);
  for (const body of [{ message: " Hello " }, '{"message":"Hello"}']) {
    res = response();
    await handler({ method: "POST", body }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { reply: "Real reply" });
    assert.equal(res.headers["Cache-Control"], "no-store");
  }
  delete process.env.DEEPSEEK_API_KEY;
  res = response();
  await handler({ method: "POST", body: { message: "Hello" } }, res);
  assert.equal(res.code, 503);
  process.env.DEEPSEEK_API_KEY = "test-secret";
  const scenarios = [
    [async () => ({ ok: false, status: 401 }), 502],
    [async () => ({ ok: false, status: 429 }), 429],
    [async () => ({ ok: true, json: async () => ({ choices: [] }) }), 502],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }), 502],
    [async () => { throw new Error("test-secret"); }, 502],
    [async () => { throw Object.assign(new Error(), { name: "TimeoutError" }); }, 504],
  ];
  for (const [mock, expected] of scenarios) {
    global.fetch = mock;
    res = response();
    await handler({ method: "POST", body: { message: "Hello" } }, res);
    assert.equal(res.code, expected);
    assert.ok(!JSON.stringify(res.body).includes("test-secret"));
  }
});

function frontend(fetchMock) {
  class Element {
    constructor() {
      this.style = {}; this.children = []; this.events = {}; this.value = "";
      this.scrollHeight = 44; this.offsetHeight = 164;
      this.classList = { add() {} };
    }
    addEventListener(name, fn) { this.events[name] = fn; }
    append(...nodes) { this.children.push(...nodes); }
    focus() {}
    remove() {}
    setAttribute(key, value) { this[key] = value; }
  }
  const form = new Element(), input = new Element(), messages = new Element(), button = new Element();
  form.querySelector = () => button;
  const nodes = { "#chat-form": form, "#message-input": input, "#messages": messages, "#empty-state": new Element(), ".composer-dock": new Element() };
  vm.runInNewContext(fs.readFileSync(require.resolve("../app.js"), "utf8"), {
    document: { querySelector: key => nodes[key], createElement: () => new Element(), documentElement: { style: { setProperty() {} } } },
    ResizeObserver: class { observe() {} }, Date, AbortSignal, fetch: fetchMock,
  });
  return { input, messages, button, submit: () => form.events.submit({ preventDefault() {} }) };
}

test("frontend posts messages, prevents duplicate sends, and renders reply as literal text", async () => {
  let resolveRequest;
  let calls = 0;
  const ui = frontend((url, options) => {
    calls++;
    assert.equal(url, "/api/chat");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { message: "Hello" });
    return new Promise(resolve => { resolveRequest = resolve; });
  });
  await ui.submit();
  assert.equal(calls, 0);
  ui.input.value = "Hello";
  const pending = ui.submit();
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.messages.children[1].children[1].textContent, "Thinking…");
  ui.input.value = "Next draft";
  await ui.submit();
  assert.equal(calls, 1);
  resolveRequest({ ok: true, json: async () => ({ reply: "<b>Literal reply</b>" }) });
  await pending;
  assert.equal(ui.messages.children[1].children[1].textContent, "<b>Literal reply</b>");
  assert.equal(ui.input.value, "Next draft");
  assert.equal(ui.button.disabled, false);
});

test("frontend shows errors, restores failed input, and preserves newer drafts", async () => {
  for (const mode of ["server", "network", "timeout", "invalid", "non-json", "new-draft"]) {
    let ui;
    ui = frontend(async () => {
      if (mode === "new-draft") ui.input.value = "New draft";
      if (mode === "network") throw new TypeError("Failed to fetch");
      if (mode === "timeout") throw Object.assign(new Error(), { name: "TimeoutError" });
      if (mode === "invalid") return { ok: true, json: async () => ({ reply: "" }) };
      if (mode === "non-json") return { ok: false, json: async () => { throw new SyntaxError(); } };
      return { ok: false, json: async () => ({ error: "Provider unavailable" }) };
    });
    ui.input.value = "Original";
    await ui.submit();
    const errorBody = ui.messages.children[1].children[1];
    assert.equal(errorBody.role, "alert");
    assert.equal(errorBody["aria-busy"], "false");
    assert.equal(ui.input.value, mode === "new-draft" ? "New draft" : "Original");
    assert.equal(ui.button.disabled, false);
  }
});
