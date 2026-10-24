"use strict";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const messages = document.querySelector("#messages");
const sendButton = form.querySelector("button");
const dock = document.querySelector(".composer-dock");
const sessionList = document.querySelector("#session-list");
const sidebar = document.querySelector("#history-sidebar");
const sidebarToggle = document.querySelector("#sidebar-toggle");
const sidebarBackdrop = document.querySelector("#sidebar-backdrop");
const storageStatus = document.querySelector("#storage-status");
const exportButton = document.querySelector("#export-chat");
const importButton = document.querySelector("#import-chat");
const importFile = document.querySelector("#import-file");
const installButton = document.querySelector("#install-app");
const standaloneMode = window.matchMedia("(display-mode: standalone)");
let deferredPrompt = null;
let installCompleted = false;

function updateInstallButton() {
  const visible = Boolean(deferredPrompt) && !installCompleted && !standaloneMode.matches && navigator.standalone !== true;
  installButton.classList.toggle("is-available", visible);
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  if (installCompleted || standaloneMode.matches || navigator.standalone === true) return;
  deferredPrompt = event;
  updateInstallButton();
});

installButton.addEventListener("click", async () => {
  if (!deferredPrompt || installButton.disabled || standaloneMode.matches || navigator.standalone === true) return;
  const prompt = deferredPrompt;
  deferredPrompt = null; // A browser install event can only be used once.
  installButton.disabled = true;
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") installCompleted = true;
  } catch {
    storageWarning("The install prompt could not open. Try your browser's install menu.");
  } finally {
    installButton.disabled = false;
    updateInstallButton();
  }
});

window.addEventListener("appinstalled", () => {
  installCompleted = true;
  deferredPrompt = null;
  updateInstallButton();
});
standaloneMode.addEventListener("change", () => {
  if (standaloneMode.matches) deferredPrompt = null;
  updateInstallButton();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => console.warn("[JAFAI] App shell could not be cached for offline use."));
  });
}
const mobileLayout = window.matchMedia("(max-width: 760px)");
const STORAGE_KEY = "jafai.chatSessions.v1";
const ACTIVE_KEY = "jafai.activeSession.v1";
const emptyState = document.querySelector("#empty-state").cloneNode(true);
let sessions = [];
let activeSessionId = null;
let currentRequest = null;
let saveTimer = null;
let storageReadable = true;
let isSending = false;
let isExporting = false;
let scrollFrame = null;
let viewportFrame = null;
let sidebarOpen = false;

function scrollChatToBottom() {
  messages.scrollTop = messages.scrollHeight;
  // Reapply after mobile layout changes have been painted, without smoothing.
  if (mobileLayout.matches && scrollFrame === null) {
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      messages.scrollTop = messages.scrollHeight;
    });
  }
}

function revealLatestMessage() {
  if (!mobileLayout.matches) return;
  messages.lastElementChild?.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" });
  scrollChatToBottom();
}

function updateMobileViewport() {
  const style = document.documentElement.style;
  if (!mobileLayout.matches) {
    style.removeProperty("--mobile-viewport-height");
    style.removeProperty("--keyboard-inset");
    style.removeProperty("--mobile-viewport-offset");
    return;
  }
  const viewport = window.visualViewport;
  // Pinch zoom is not a keyboard resize; leave the user's zoom intact.
  if (viewport && viewport.scale !== 1) return;
  const height = viewport?.height || window.innerHeight;
  const inset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop || 0));
  style.setProperty("--mobile-viewport-height", `${height}px`);
  style.setProperty("--keyboard-inset", `${inset}px`);
  style.setProperty("--mobile-viewport-offset", `${viewport?.offsetTop || 0}px`);
}

function handleMobileViewportChange() {
  if (!mobileLayout.matches || viewportFrame !== null) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = null;
    updateMobileViewport();
    if (document.activeElement === input) revealLatestMessage();
    else scrollChatToBottom();
  });
}

function storageWarning(text) {
  storageStatus.textContent = text;
  storageStatus.hidden = !text;
}

function loadSessions() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) throw new Error("Invalid history");
    const ids = new Set();
    sessions = stored.map((session) => {
      if (!session || typeof session.id !== "string" || !session.id || ids.has(session.id)
        || typeof session.title !== "string" || !Number.isFinite(Date.parse(session.timestamp))
        || !Array.isArray(session.messages)) throw new Error("Invalid session");
      ids.add(session.id);
      return {
        id: session.id, title: session.title, timestamp: session.timestamp,
        messages: session.messages.map((message) => {
          if (!message || !["user", "assistant"].includes(message.role)
            || typeof message.content !== "string" || !Number.isFinite(Date.parse(message.timestamp))) {
            throw new Error("Invalid message");
          }
          const interrupted = message.status === "streaming";
          return {
            role: message.role,
            content: interrupted ? `${message.content}${message.content ? "\n\n" : ""}Response interrupted. Send your message again to retry.` : message.content,
            timestamp: message.timestamp,
            status: interrupted ? "interrupted" : message.status === "error" || message.status === "interrupted" ? message.status : "complete",
          };
        }),
      };
    });
    const savedActive = localStorage.getItem(ACTIVE_KEY);
    activeSessionId = sessions.some((session) => session.id === savedActive)
      ? savedActive : savedActive === "" ? null : sessions[0]?.id || null;
  } catch {
    sessions = [];
    storageReadable = false;
    storageWarning("Saved history could not be read. Chats will stay in memory for this visit.");
  }
}

function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!storageReadable) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_KEY, activeSessionId || "");
    storageWarning("");
    return true;
  } catch {
    storageWarning("History could not be saved. Browser storage may be full or unavailable.");
    return false;
  }
}

function scheduleSave() {
  if (saveTimer === null) saveTimer = setTimeout(saveSessions, 200);
}

async function exportActiveChat() {
  if (!activeSessionId || isExporting) return;
  // Flush pending stream text before reading the saved snapshot for export.
  if ((saveTimer !== null || currentRequest) && !saveSessions()) return;
  isExporting = true;
  exportButton.disabled = true;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    const session = Array.isArray(stored) ? stored.find((item) => item?.id === activeSessionId) : null;
    if (!session || !Array.isArray(session.messages)) throw new Error("No saved chat");
    const transcript = session.messages.map((message) => {
      if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
        throw new Error("Invalid saved message");
      }
      return message.content.trim() ? `${message.role === "user" ? "USER" : "JAFAI"}: ${message.content}` : "";
    }).filter(Boolean).join("\n\n");
    if (!transcript) throw new Error("Empty chat");

    const date = new Date(session.timestamp).toISOString().slice(0, 10);
    const title = String(session.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    const filename = `jafai-chat-${date}${title ? `-${title}` : ""}.txt`;
    const blob = new Blob([`${transcript}\n`], { type: "text/plain;charset=utf-8" });
    if (typeof navigator.share === "function" && typeof navigator.canShare === "function" && typeof File === "function") {
      const file = new File([blob], filename, { type: "text/plain" });
      try {
        if (navigator.canShare({ files: [file] })) {
          // Keep this in the click handler, before any other asynchronous work.
          await navigator.share({ files: [file], title: session.title || "JAFAI Chat" });
          return;
        }
      } catch (error) {
        // Dismissing the share sheet must not trigger an unwanted download.
        if (error.name === "AbortError") return;
        // Unsupported or blocked file sharing falls back to a local download.
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    try {
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      // Allow the browser to start the download before releasing the Blob URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch {
    storageWarning("This saved chat could not be exported. Check that browser storage is available.");
  } finally {
    isExporting = false;
    updateComposer();
  }
}

function parseChatText(text) {
  const parsed = [];
  let current = null;
  for (const line of text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const label = /^(USER|JAFAI):[ \t]?(.*)$/.exec(line);
    if (label) {
      current = { role: label[1] === "USER" ? "user" : "assistant", lines: [label[2]] };
      parsed.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      throw new Error("Choose a JAFAI export with USER: and JAFAI: message labels.");
    }
  }
  if (!parsed.length || parsed[0].role !== "user" || parsed.length > 1000) {
    throw new Error("Import needs a USER: message first and a maximum of 1,000 messages.");
  }
  const timestamp = new Date().toISOString();
  const restored = parsed.map((message) => ({
    role: message.role, content: message.lines.join("\n").trim(), timestamp, status: "complete",
  }));
  if (restored.some((message) => !message.content)) throw new Error("The chat contains an empty message.");
  if (restored.reduce((length, message) => length + message.content.length, 0) > 500000) {
    throw new Error("The chat is too large (maximum 500,000 characters).");
  }
  return restored;
}

async function importChat() {
  const file = importFile.files?.[0];
  if (!file || importButton.disabled) return;
  importButton.disabled = true;
  try {
    if (!/\.txt$/i.test(file.name) || file.size > 1024 * 1024) {
      throw new Error("Choose a .txt chat export smaller than 1 MB.");
    }
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("The file could not be read. Please try again."));
      reader.onabort = () => reject(new Error("File import was cancelled."));
      reader.readAsText(file, "UTF-8");
    });
    const restored = parseChatText(text);
    if (!storageReadable) throw new Error("Browser storage is unavailable. The chat could not be imported.");
    stopResponse();
    const previousActive = activeSessionId;
    const session = {
      id: crypto.randomUUID(), title: Array.from(restored[0].content).slice(0, 30).join(""),
      timestamp: new Date().toISOString(), messages: restored,
    };
    sessions.unshift(session);
    activeSessionId = session.id;
    if (!saveSessions()) {
      sessions.shift();
      activeSessionId = previousActive;
      renderConversation();
      updateComposer();
      throw new Error("Browser storage could not save the imported chat.");
    }
    selectSession(session.id);
  } catch (error) {
    storageWarning(`Import failed: ${error.message}`);
  } finally {
    importButton.disabled = false;
    importFile.value = "";
  }
}

function renderHistory() {
  sessionList.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Your conversations will appear here.";
    sessionList.append(empty);
  }
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = `session-row${session.id === activeSessionId ? " is-active" : ""}`;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "session-open";
    if (session.id === activeSessionId) open.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title;
    const date = document.createElement("time");
    date.className = "session-date";
    date.dateTime = session.timestamp;
    date.textContent = new Date(session.timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
    open.append(title, date);
    open.addEventListener("click", () => selectSession(session.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "session-delete";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete chat: ${session.title}`);
    remove.addEventListener("click", () => deleteSession(session.id));
    row.append(open, remove);
    sessionList.append(row);
  }
}

function renderConversation() {
  messages.replaceChildren();
  const session = sessions.find((item) => item.id === activeSessionId);
  if (!session?.messages.length) messages.append(emptyState.cloneNode(true));
  for (const message of session?.messages || []) {
    const body = appendMessage(message.role === "user" ? "You" : "JAFAI", message.content, message.timestamp);
    if (["error", "interrupted"].includes(message.status)) body.classList.add("message-body--error");
  }
}

function stopResponse() {
  if (!currentRequest) return;
  const request = currentRequest;
  currentRequest = null;
  request.controller.abort();
  request.reply.content += `${request.reply.content ? "\n\n" : ""}Response stopped.`;
  request.reply.status = "interrupted";
  isSending = false;
  saveSessions();
  updateComposer();
}

function selectSession(id) {
  if (id !== null && !sessions.some((session) => session.id === id)) return;
  if (id !== activeSessionId) stopResponse();
  activeSessionId = id;
  input.value = "";
  renderHistory();
  // Selecting the currently streaming chat must not detach its live bubble.
  if (!currentRequest) renderConversation();
  saveSessions();
  updateComposer();
  if (mobileLayout.matches) setSidebar(false);
  input.focus();
}

function deleteSession(id) {
  const wasActive = id === activeSessionId;
  if (wasActive) stopResponse();
  sessions = sessions.filter((session) => session.id !== id);
  if (wasActive) {
    activeSessionId = sessions[0]?.id || null;
    input.value = "";
    renderConversation();
    updateComposer();
  }
  saveSessions();
  renderHistory();
  input.focus();
}

function setSidebar(open) {
  sidebarOpen = open;
  sidebar.classList.toggle("sidebar-closed", !open);
  sidebar.inert = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
  sidebarBackdrop.hidden = !open || !mobileLayout.matches;
  document.querySelector(".app").inert = open && mobileLayout.matches;
  document.body.classList.toggle("sidebar-open", open);
  sidebarToggle.setAttribute("aria-expanded", String(open));
  if (open) document.querySelector("#sidebar-close").focus();
  else sidebarToggle.focus();
}

function updateComposer() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  sendButton.disabled = isSending || !input.value.trim();
  exportButton.disabled = isExporting || !sessions.some((session) => session.id === activeSessionId && session.messages.some((message) => message.content.trim()));
}

function appendMessage(author, content, timestamp = new Date().toISOString()) {
  const message = document.createElement("article");
  message.className = `message message--${author === "JAFAI" ? "assistant" : "user"}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.className = "message-author";
  name.textContent = author;
  const time = document.createElement("time");
  const now = new Date(timestamp);
  time.className = "message-time";
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.append(name, time);

  const body = document.createElement(author === "JAFAI" ? "div" : "p");
  body.className = "message-body";
  body.textContent = content;
  message.append(meta, body);
  messages.append(message);
  scrollChatToBottom();
  return body;
}

async function readChatStream(response, onText) {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("Chat returned an invalid stream. Please try again.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let receivedText = "";

  function processEvent(event) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return; // Ignore keep-alive comments and metadata.
    if (data.trim() === "[DONE]") { finished = true; return; }
    let chunk;
    try { chunk = JSON.parse(data); }
    catch { throw new Error("Chat returned an invalid stream. Please try again."); }
    if (chunk.error) throw new Error("The AI service interrupted the response. Please try again.");
    const text = chunk.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) {
      receivedText += text;
      onText(text);
    }
  }

  function drainEvents() {
    let boundary;
    while (!finished && (boundary = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      processEvent(event);
    }
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      drainEvents();
      if (done) {
        if (!finished && buffer.trim()) processEvent(buffer);
        break;
      }
    }
    if (!finished) throw new Error("The response was interrupted. Please try again.");
    if (!receivedText.trim()) throw new Error("The AI service returned an empty response. Please try again.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || isSending) return;

  isSending = true;
  let session = sessions.find((item) => item.id === activeSessionId);
  if (!session) {
    session = {
      id: crypto.randomUUID(), title: Array.from(text).slice(0, 30).join(""),
      timestamp: new Date().toISOString(), messages: [],
    };
    sessions.unshift(session);
    activeSessionId = session.id;
  }
  session.timestamp = new Date().toISOString();
  const userMessage = { role: "user", content: text, timestamp: new Date().toISOString(), status: "complete" };
  const assistantMessage = { role: "assistant", content: "", timestamp: new Date().toISOString(), status: "streaming" };
  session.messages.push(userMessage, assistantMessage);
  const request = { controller: new AbortController(), reply: assistantMessage };
  currentRequest = request;
  document.querySelector("#empty-state")?.remove();
  appendMessage("You", text, userMessage.timestamp);
  input.value = "";
  updateComposer();
  const replyBody = appendMessage("JAFAI", "Thinking…", assistantMessage.timestamp);
  replyBody.setAttribute("aria-busy", "true");
  if (mobileLayout.matches) {
    input.blur();
    document.activeElement?.blur();
    setTimeout(() => {
      if (activeSessionId !== session.id) return;
      updateMobileViewport();
      scrollChatToBottom();
    }, 150);
  } else {
    input.focus({ preventScroll: true });
  }
  // Measure the cleared composer now rather than waiting for ResizeObserver.
  document.documentElement.style.setProperty("--dock-height", `${dock.offsetHeight}px`);
  updateMobileViewport();
  if (mobileLayout.matches) revealLatestMessage();
  scrollChatToBottom();
  saveSessions();
  renderHistory();
  let hasReply = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: session.messages.slice(0, -2)
          .filter((message) => message.status === "complete" && message.content.trim())
          .map((message) => ({ role: message.role, content: message.content })),
      }),
      signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(35000)]),
    });
    if (currentRequest !== request) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || "Chat is unavailable. Please try again.");
    }
    await readChatStream(response, (text) => {
      if (currentRequest !== request) return;
      if (!hasReply) { replyBody.textContent = ""; hasReply = true; }
      const span = document.createElement("span");
      span.className = "fade-in-word";
      span.textContent = text;
      replyBody.append(span);
      // Every delta must reveal its final line before any persistence work.
      scrollChatToBottom();
      assistantMessage.content += text;
      scheduleSave();
    });
    if (currentRequest === request) assistantMessage.status = "complete";
  } catch (error) {
    if (currentRequest !== request) return;
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    const errorText = timedOut
      ? "The request timed out. Please try again."
      : `Could not send: ${error.message || "Check your connection and try again."}`;
    if (hasReply) {
      const notice = document.createElement("span");
      notice.className = "stream-error";
      notice.textContent = `\n\n${errorText}`;
      replyBody.append(notice);
    } else {
      replyBody.textContent = errorText;
    }
    replyBody.classList.add("message-body--error");
    replyBody.setAttribute("role", "alert");
    assistantMessage.content = replyBody.textContent;
    assistantMessage.status = "error";
    // Preserve the failed message for retry without replacing a new draft.
    if (!input.value) input.value = text;
  } finally {
    if (currentRequest === request) {
      replyBody.setAttribute("aria-busy", "false");
      currentRequest = null;
      isSending = false;
      saveSessions();
      updateComposer();
      scrollChatToBottom();
    }
  }
});

input.addEventListener("input", updateComposer);
input.addEventListener("focus", () => {
  if (!mobileLayout.matches) return;
  updateMobileViewport();
  requestAnimationFrame(revealLatestMessage);
});
window.visualViewport?.addEventListener("resize", handleMobileViewportChange);
window.visualViewport?.addEventListener("scroll", handleMobileViewportChange);
window.addEventListener("resize", handleMobileViewportChange);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

// Track composer growth and keep the latest message visible as the textarea resizes.
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--dock-height", `${dock.offsetHeight}px`);
  scrollChatToBottom();
}).observe(dock);

sidebarToggle.addEventListener("click", () => setSidebar(true));
exportButton.addEventListener("click", exportActiveChat);
importButton.addEventListener("click", () => { importFile.value = ""; importFile.click(); });
importFile.addEventListener("change", importChat);
document.querySelector("#sidebar-close").addEventListener("click", () => setSidebar(false));
sidebarBackdrop.addEventListener("click", () => setSidebar(false));
document.querySelector("#new-chat").addEventListener("click", () => selectSession(null));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sidebarOpen) setSidebar(false);
});
mobileLayout.addEventListener("change", () => {
  setSidebar(!mobileLayout.matches);
  updateMobileViewport();
});
window.addEventListener("pagehide", saveSessions);
loadSessions();
renderHistory();
renderConversation();
setSidebar(!mobileLayout.matches);
updateComposer();
updateMobileViewport();
