const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");

function worker(fetchImpl) {
  const handlers = {};
  const stores = new Map();
  const installed = [];
  const cache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return {
      addAll: async (requests) => {
        for (const request of requests) {
          const pathname = new URL(request.url).pathname;
          installed.push(pathname);
          assert.ok(fs.existsSync(path.join(root, pathname === "/" ? "index.html" : pathname.slice(1))));
          stores.get(name).set(pathname, new Response(`cached:${pathname}`));
        }
      },
      put: async (key, response) => { stores.get(name).set(key, response); },
    };
  };
  const caches = {
    open: async (name) => cache(name), keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (key, options) => stores.get(options.cacheName)?.get(key)?.clone(),
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "sw.js"), "utf8"), {
    self: { addEventListener: (name, fn) => { handlers[name] = fn; }, location: { origin: "https://jafai.test" }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches, fetch: fetchImpl, URL,
    Request: class extends Request { constructor(url, options) { super(new URL(url, "https://jafai.test"), options); } },
  });
  return { handlers, stores, installed };
}

test("manifest supplies standalone launch metadata and real 192px/512px PNG icons", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((item) => item.sizes === `${size}x${size}`);
    const data = fs.readFileSync(path.join(root, icon.src.slice(1)));
    assert.equal(data.readUInt32BE(16), size);
    assert.equal(data.readUInt32BE(20), size);
    assert.equal(icon.type, "image/png");
  }
});

test("service worker precaches the app shell and removes only old JAFAI shell caches", async () => {
  const sw = worker(async () => new Response("network"));
  let pending;
  sw.handlers.install({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.ok(sw.installed.includes("/app.js"));
  assert.ok(sw.installed.includes("/index.html"));
  assert.ok(sw.installed.includes("/styles.css"));
  assert.ok(!sw.installed.some((item) => item.includes("knowledge") || item.includes("api")));
  sw.stores.set("jafai-shell-old", new Map());
  sw.stores.set("unrelated-cache", new Map());
  sw.handlers.activate({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.equal(sw.stores.has("jafai-shell-old"), false);
  assert.equal(sw.stores.has("unrelated-cache"), true);
  assert.equal(sw.stores.has("jafai-shell-v1"), true);
});

test("service worker uses fresh network assets, falls back offline, and never intercepts private/API traffic", async () => {
  let offline = false;
  let fetchCalls = 0;
  const sw = worker(async () => { fetchCalls++; if (offline) throw new Error("offline"); return new Response("fresh asset"); });
  let install;
  sw.handlers.install({ waitUntil: (promise) => { install = promise; } });
  await install;
  for (const request of [
    new Request("https://jafai.test/api/chat", { method: "POST" }),
    new Request("https://jafai.test/api/chat"), new Request("https://jafai.test/knowledge/manual.txt"),
    new Request("https://jafai.test/.env"), new Request("https://other.test/app.js"),
  ]) {
    sw.handlers.fetch({ request, respondWith: () => assert.fail("Private traffic intercepted") });
  }
  assert.equal(fetchCalls, 0);
  async function get(url) {
    let response;
    const waits = [];
    sw.handlers.fetch({ request: new Request(url), respondWith: (promise) => { response = promise; }, waitUntil: (promise) => waits.push(promise) });
    const result = await response;
    await Promise.all(waits);
    return result.text();
  }
  assert.equal(await get("https://jafai.test/app.js"), "fresh asset");
  offline = true;
  assert.equal(await get("https://jafai.test/app.js"), "fresh asset");
  assert.equal(await get("https://jafai.test/?from=homescreen"), "cached:/");
});
