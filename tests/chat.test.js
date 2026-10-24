const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const handler = require("../api/chat.js");
const { Writable } = require("node:stream");

function sseResponse(text = "Real reply") {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function response() {
  const res = new Writable({ write(chunk, _encoding, callback) { res.chunks.push(Buffer.from(chunk)); callback(); } });
  res.chunks = [];
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.status = (code) => { res.code = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.flushHeaders = () => { res.headersSent = true; };
  return res;
}

test("backend validates requests and handles provider responses without exposing secrets", async (t) => {
  t.mock.method(fs.promises, "readdir", async () => []);
  t.mock.method(fs.promises, "readFile", async () => "");
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
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
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.messages, [
      { role: "system", content: "You are JAFAI (Just Another Fucking AI). Speak in the Street Dialect with the calm, quiet confidence of a seasoned intelligence officer or a street-smart mentor. Be direct, matter-of-fact, and grounded. Avoid aggressive introductions, theatrical toughness, and lists of what you are not.\n\nWrite in natural, conversational paragraphs. Do not use Markdown formatting like asterisks (**) for bold text. Do not use hashtags (#) for headers. Only use plain text and standard punctuation. If you must list items, use a simple hyphen (-) without bolding the text. Use a list only when necessary, with a maximum of 3 short bullet points.\n\nConserve Mana: the user may be tired. Be concise and give the structural truth directly. Keep answers short unless the user asks for depth or the subject needs it.\n\nKeep the Fear and Invoice diagnostic lens, the Street Dialect, and the refusal to use corporate smoothing or jargon. Apply the framework with calm clarity rather than aggression. Use Knowledge V1 for substance; these tone and formatting rules govern how you express it." },
      { role: "user", content: "Hello" },
    ]);
    return sseResponse();
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
    assert.equal(Buffer.concat(res.chunks).toString(), await sseResponse().text());
    assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
    assert.equal(res.headers["Cache-Control"], "no-cache, no-store, no-transform");
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

test("Knowledge folder loads sorted text files and falls back safely for empty or unavailable knowledge", async (t) => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });
  process.env.DEEPSEEK_API_KEY = "test-secret";
  let scenario;
  let reads;
  const warning = t.mock.method(console, "warn", () => {});
  const logging = t.mock.method(console, "log", () => {});
  const directory = require("node:path").join(process.cwd(), "knowledge");
  const entry = (name, isFile = true) => ({ name, isFile: () => isFile });
  t.mock.method(fs.promises, "readdir", async (filename, options) => {
    assert.equal(filename, directory);
    assert.deepEqual(options, { withFileTypes: true });
    if (scenario === "missing") throw Object.assign(new Error(), { code: "ENOENT" });
    if (scenario === "empty") return [];
    if (scenario === "content" || scenario === "partial") {
      return [entry("z.TXT"), entry("image.png"), entry("nested.txt", false), entry("a.txt")];
    }
    return [entry("a.txt")];
  });
  t.mock.method(fs.promises, "readFile", async (filename, encoding) => {
    reads.push(require("node:path").basename(filename));
    assert.equal(require("node:path").dirname(filename), directory);
    assert.equal(encoding, "utf8");
    if (scenario === "unreadable" || (scenario === "partial" && filename.endsWith("z.TXT"))) {
      throw Object.assign(new Error(), { code: "EACCES" });
    }
    if (scenario === "blank") return " \n\t";
    return filename.endsWith("a.txt") ? "  Manual text.\nSecond paragraph.  " : "Extra text.";
  });
  let sentPrompt;
  t.mock.method(global, "fetch", async (_url, options) => {
    sentPrompt = JSON.parse(options.body).messages[0].content;
    return sseResponse("Answer");
  });
  const base = "You are JAFAI (Just Another Fucking AI). Speak in the Street Dialect with the calm, quiet confidence of a seasoned intelligence officer or a street-smart mentor. Be direct, matter-of-fact, and grounded. Avoid aggressive introductions, theatrical toughness, and lists of what you are not.\n\nWrite in natural, conversational paragraphs. Do not use Markdown formatting like asterisks (**) for bold text. Do not use hashtags (#) for headers. Only use plain text and standard punctuation. If you must list items, use a simple hyphen (-) without bolding the text. Use a list only when necessary, with a maximum of 3 short bullet points.\n\nConserve Mana: the user may be tired. Be concise and give the structural truth directly. Keep answers short unless the user asks for depth or the subject needs it.\n\nKeep the Fear and Invoice diagnostic lens, the Street Dialect, and the refusal to use corporate smoothing or jargon. Apply the framework with calm clarity rather than aggression. Use Knowledge V1 for substance; these tone and formatting rules govern how you express it.";
  for (scenario of ["content", "empty", "blank", "missing", "unreadable", "partial"]) {
    reads = [];
    const before = warning.mock.callCount();
    const res = response();
    await handler({ method: "POST", body: { message: "Hello" } }, res);
    assert.equal(res.code, 200);
    const count = scenario === "content" ? 2 : scenario === "partial" ? 1 : 0;
    assert.equal(sentPrompt, count
      ? `${base}\n\nHere is your Knowledge Base (Knowledge V1). Use it to inform your answers, but do not quote it word-for-word unless necessary:\nManual text.\nSecond paragraph.${count === 2 ? "\n\nExtra text." : ""}`
      : base);
    assert.equal(warning.mock.callCount() - before, scenario === "content" ? 0 : scenario === "unreadable" ? 2 : 1);
    assert.equal(logging.mock.calls.at(-1).arguments[0], `[JAFAI] Loaded ${count} knowledge files.`);
    if (scenario === "content" || scenario === "partial") assert.deepEqual(reads, ["a.txt", "z.TXT"]);
    if (scenario === "missing" || scenario === "empty") assert.deepEqual(reads, []);
  }
});

function frontend(fetchMock) {
  class Element {
    constructor() {
      this.style = {}; this.children = []; this.events = {}; this.value = "";
      this.scrollHeight = 44; this.offsetHeight = 164;
      this.classList = { add() {} };
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || "") + this.children.map(child => child.textContent).join(""); }
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
    ResizeObserver: class { observe() {} }, Date, AbortSignal, TextDecoder, fetch: fetchMock,
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
  resolveRequest(sseResponse("<b>Literal reply</b>"));
  await pending;
  assert.equal(ui.messages.children[1].children[1].textContent, "<b>Literal reply</b>");
  assert.equal(ui.messages.children[1].children[1].children[0].className, "fade-in-word");
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

test("frontend renders before completion and parses byte-split UTF-8 and CRLF SSE events", async () => {
  let streamController;
  let rendered;
  const firstRendered = new Promise(resolve => { rendered = resolve; });
  const ui = frontend(async () => new Response(new ReadableStream({ start(controller) { streamController = controller; } }), {
    headers: { "Content-Type": "text/event-stream" },
  }));
  ui.input.value = "Hello";
  const pending = ui.submit();
  const reply = ui.messages.children[1].children[1];
  const originalAppend = reply.append.bind(reply);
  reply.append = (...nodes) => { originalAppend(...nodes); rendered(); };
  const encoder = new TextEncoder();
  const event = `: keep-alive\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: "Kia ora 🌋\n" } }] })}\r\n\r\n`;
  for (const byte of encoder.encode(event)) streamController.enqueue(Uint8Array.of(byte));
  await firstRendered;
  assert.equal(reply.textContent, "Kia ora 🌋\n");
  assert.equal(ui.button.disabled, true);
  streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Next line"}}]}\n\ndata: [DONE]\n\n'));
  // The client stops at [DONE] without waiting for the connection to close.
  await pending;
  assert.equal(reply.textContent, "Kia ora 🌋\nNext line");
  assert.equal(reply.children.length, 2);
  assert.equal(ui.button.disabled, true); // Empty composer after successful send.
  assert.equal(reply["aria-busy"], "false");
});

test("frontend handles empty, malformed, and interrupted streams, preserving partial answers", async () => {
  const cases = [
    ['data: [DONE]\n\n', "empty response"],
    ['data: {broken}\n\n', "invalid stream"],
    ['data: {"error":{"message":"provider detail"}}\n\n', "interrupted"],
    ['data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n', "interrupted"],
  ];
  for (const [wire, expected] of cases) {
    const ui = frontend(async () => new Response(wire, { headers: { "Content-Type": "text/event-stream" } }));
    ui.input.value = "Question";
    await ui.submit();
    const reply = ui.messages.children[1].children[1];
    assert.ok(reply.textContent.includes(expected));
    if (wire.includes("Partial answer")) assert.ok(reply.textContent.startsWith("Partial answer\n\n"));
    assert.equal(ui.input.value, "Question");
    assert.equal(reply.role, "alert");
    assert.equal(ui.button.disabled, false);
  }
});

test("backend forwards bytes before upstream completes and aborts on client disconnect", async (t) => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });
  process.env.DEEPSEEK_API_KEY = "test-secret";
  t.mock.method(fs.promises, "readdir", async () => [{ name: "manual.txt", isFile: () => true }]);
  t.mock.method(fs.promises, "readFile", async () => "Manual");
  t.mock.method(console, "log", () => {});
  let upstream;
  let signal;
  let cancelled = false;
  t.mock.method(global, "fetch", async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { upstream = controller; },
      cancel() { cancelled = true; },
    }));
  });
  const res = response();
  const request = handler({ method: "POST", body: { message: "Hello" } }, res);
  // Let the handler reach the reader, then provide only the first SSE event.
  await new Promise(resolve => setImmediate(resolve));
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"First"}}]}\n\n');
  upstream.enqueue(bytes);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Buffer.concat(res.chunks), Buffer.from(bytes));
  assert.equal(res.writableEnded, false);
  res.destroy();
  await request;
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(res.body, undefined); // Never mix JSON errors into a started stream.
});
