# JAFAI

A vanilla HTML, CSS, and JavaScript chat frontend with a Vercel Serverless backend.

The root manifest and service worker enable PWA installation. The header's
`[ Install App ]` action is hidden until the browser fires `beforeinstallprompt`.
It opens that native prompt on click, hides after acceptance, and stays hidden
in standalone mode (including iOS `navigator.standalone`). Dismissed prompts
are single-use; the button waits for the browser to offer a new one. Browsers
without this event, including iOS Safari, use their own Add to Home Screen menu.

The service worker caches only the public shell (HTML, CSS, JS, logo, manifest,
and app icons). It tries the network first and uses cached assets when offline.
Chat API requests, knowledge files, and chat history are never intercepted or
cached by it. Offline users can browse their local history and import/export
chats; new AI responses require an internet connection. Old JAFAI shell caches
are removed on worker activation; localStorage is retained. Installation and
service worker support require HTTPS (or localhost during development).

Deploy this directory to Vercel using the Other framework preset, no build
command, and the project root as the output directory. Add `DEEPSEEK_API_KEY`
in the project's environment variables for the environments you use, then
deploy (or redeploy after changing the key). The key stays on the server.

For local development, use `npx vercel dev` with `DEEPSEEK_API_KEY` in
`.env.local` (see `.env.example`). Opening `index.html` directly or using a
static-only server will display the UI but cannot run `/api/chat`.

Type a message and press Enter or click the arrow to send. Shift+Enter adds a
new line. The frontend posts `{ "message": "...", "history": [...] }` to `/api/chat`, which
returns DeepSeek's raw server-sent events (SSE), or a JSON `error` before the
stream begins. The browser decodes content deltas incrementally into fading
text spans, scrolling as the answer grows. Reduced-motion preferences disable
the animation. Interrupted streams retain partial text with an inline error.
On mobile, keyboard resizes update the visible chat height and composer offset.
Input focus reveals the latest message, and each streamed chunk forces the chat
to the bottom immediately and after the next mobile layout frame.
On mobile, Send blurs the input to dismiss the keyboard, then rechecks viewport
size and scrolls again after 150ms. The mobile chat's bottom padding tracks the
measured composer height. Desktop Send retains its existing input focus.
The viewport meta tag requests `interactive-widget=resizes-content`; VisualViewport supplies
a fallback for overlay keyboards. These layout adjustments are limited to the
existing mobile breakpoint; desktop layout and focus behavior stay unchanged.
Sending is disabled during a
request; failures appear inline and restore the message for retry if there
is no newer draft.

Chat sessions are saved in this browser's `localStorage` under
`jafai.chatSessions.v1`. Each session contains an ID, the first 30 characters of
its first user message as its title, a last-message timestamp, and messages
with roles, content, timestamps, and delivery status. The last selected session
is remembered under `jafai.activeSession.v1`. New Chat creates a session only
when the first message is sent. The sidebar restores, selects, and deletes
saved sessions. Switching chats stops an in-flight response and keeps partial
text; deleting the active chat also stops it. Streaming text is saved at most
every 200ms and flushed when the response ends or the page is hidden.

The history vault is client-side only; no database, account, or history-sync
API is involved. Browser storage is specific to the site's origin and browser
profile; clearing site data removes it. Storage failures show an inline notice
and leave the current chat usable in memory. Malformed stored history is left
untouched. On send, the active conversation's prior completed messages and the
new user message are sent to the cloud endpoint for conversation context. Other
saved sessions are not included. Failed and interrupted assistant responses are
excluded from follow-up context.

`[ Export Chat ]` exports the active saved conversation as a UTF-8 `.txt`
file with `USER:` and `JAFAI:` labels. The filename includes the session date
and a sanitized title. Where `navigator.canShare({ files })` confirms support,
the export opens the native share sheet with the text file. Otherwise it uses
the local Blob download. Share failures fall back to download, except that
cancelling the share sheet does nothing. Export does not call the backend.
Pending streamed text is saved before export. The share sheet requires HTTPS
(or localhost) and a user click; available save/share targets depend on the device.
The action is disabled for a blank New Chat.

`[ Import Chat ]` uses the browser's native file picker (`.txt` / `text/plain`,
without camera capture) and FileReader to restore
`USER:` / `JAFAI:` message blocks into a new saved session. Multiline messages,
UTF-8, Windows line endings, and a UTF-8 BOM are supported. Import itself makes
no network request; imported content is sent as conversation context only when
the user sends a new message. The first message must be `USER:`. Labels must
start at the beginning of a line; label-like lines inside message text are
interpreted as new message boundaries by this plain-text format. Import accepts
files up to 1 MB and transcripts up to 1,000 messages / 500,000 content characters.
Invalid files leave the existing sessions intact and show an inline error.

The backend sends the active conversation's history, current message, and JAFAI system prompt to
`https://api.deepseek.com/v1/chat/completions` using `deepseek-chat`, exactly as
requested. History accepts only `user` and `assistant` roles, with a maximum of
1,000 messages and 500,000 characters. Oversized history is rejected rather than
silently truncated; the provider's context limit still applies alongside the knowledge base.
The provider request times out after 25 seconds; the function allows 30 seconds.
No SDK or runtime dependencies are required (use a current Vercel Node.js runtime).

The model name is deliberately fixed to the requested `deepseek-chat`; current
DeepSeek documentation lists newer model names. Verify its availability with
your account before relying on it in production.

Run `node --test` to exercise the backend and frontend with mocked requests.

Store Knowledge V1 as UTF-8 `.txt` files directly inside `knowledge/`, then deploy
the updated files. The existing manifesto is in `knowledge/knowledge-v1.txt`.
On each request, the function loads text files in filename order and joins their
contents with blank lines before appending them to the system prompt. Other
file types and subdirectories are ignored. Blank files are skipped; unreadable
files generate a warning without preventing other files from loading. An empty
or missing folder falls back to the base prompt. Server logs report the number
of non-empty files loaded. `vercel.json` includes `knowledge/**` in the function
bundle. The combined text is sent with each message and must fit the model's
context limit.

`jafai-logo.png` is a copy of the supplied `Image conpets/Jafai Logo.png`.
