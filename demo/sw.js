// The replay worker. In the app, a Cup's page is served by a small Python
// worker on the same computer and asks it for everything under /api/. In a
// demo the same page, unchanged, sits at /demo/<cup>/app/ and this worker
// stands in for the Python one: it serves the page's own files, and answers
// /api/ requests from a recording of what the real worker said. Nothing here
// knows about any one Cup.
importScripts('key.js');

const APP = /^\/demo\/([a-z0-9-]+)\/app\//;
const MISS = 'This demo only has the prepared examples. Choose one of the examples above the page.';
const recordings = new Map(); // cup → the recording, once fetched
const asked = new Map();      // cup → how often each request has been made since its page loaded

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === location.origin) event.respondWith(route(event, url));
});

// Which demo, if any, a request belongs to: the page that made it, or for a
// page load, the page being left.
async function demoOf(event, url) {
  if (event.request.mode === 'navigate') return APP.exec(url.pathname)?.[1] ?? cupIn(event.request.referrer);
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  return cupIn(client?.url) ?? cupIn(event.request.referrer);
}
function cupIn(address) {
  try { return APP.exec(new URL(address).pathname)?.[1] ?? null; } catch { return null; }
}

async function route(event, url) {
  const { request } = event;
  const cup = await demoOf(event, url);
  if (!cup) return fetch(request);
  if (request.mode === 'navigate') {
    // The page is loading afresh, so the worker's answers start from the beginning.
    if (APP.test(url.pathname)) asked.delete(cup);
    return fetch(request);
  }
  if (url.pathname.startsWith('/api/')) return replay(cup, request, url);
  // The one file a demo swaps: its picker offers prepared samples, never a file of the visitor's.
  if (url.pathname.endsWith('/file-picker.js')) return carried('/demo/file-picker.js');
  if (url.pathname.startsWith('/demo/')) return fetch(request);
  // The page believes it lives at "/", as it does in the app.
  return carried(`/demo/${cup}/app${url.pathname}`);
}

// A copy of the answer without its address, so scripts keep resolving their imports from where the page asked.
// The browser is told not to keep it: every Cup asks for /app.js, and a kept one is the last demo's.
async function carried(path) {
  const found = await fetch(path);
  const headers = new Headers(found.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(found.body, { status: found.status, headers });
}

async function recordingOf(cup) {
  if (!recordings.has(cup)) {
    recordings.set(cup, fetch(`/demo/${cup}/recording.json`).then((found) => {
      if (!found.ok) throw new Error('No recording');
      return found.json();
    }).catch(() => { recordings.delete(cup); return { exchanges: {}, aliases: {} }; }));
  }
  return recordings.get(cup);
}

async function replay(cup, request, url) {
  const { exchanges, aliases = {} } = await recordingOf(cup);
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.clone().arrayBuffer();
  const key = await demoKey({ method: request.method, path: url.pathname, search: url.search, type: request.headers.get('content-type') ?? '', body });
  let name = key;
  if (!exchanges[name]) {
    // A request the recording answers with another's reply: a native folder chooser cannot be recorded, typing the same folder can.
    const stand = aliases[`${request.method} ${url.pathname}`];
    name = stand && Object.keys(exchanges).find((known) => known === stand || known.startsWith(`${stand} `) || known.startsWith(`${stand}?`));
  }
  const replies = exchanges[name];
  if (!replies) {
    tell(cup, { type: 'miss', key });
    return new Response(JSON.stringify({ error: MISS }), { status: 501, headers: { 'Content-Type': 'application/json' } });
  }
  // A request made again gets the next thing the worker said, then the last one for good.
  const turns = asked.get(cup) ?? asked.set(cup, new Map()).get(cup);
  const turn = turns.get(name) ?? 0;
  turns.set(name, turn + 1);
  const reply = replies[Math.min(turn, replies.length - 1)];
  tell(cup, { type: 'replayed', key, ms: reply.ms ?? 0 });
  const headers = { 'Content-Type': reply.type, 'Cache-Control': 'no-store' };
  if ('json' in reply) return new Response(JSON.stringify(reply.json), { status: reply.status, headers });
  if (!reply.file) return new Response(null, { status: reply.status, headers });
  const file = await fetch(`/demo/${cup}/files/${reply.file}`);
  return new Response(file.body, { status: file.ok ? reply.status : 502, headers });
}

// The demo's own page (the strip above the Cup) hears what was replayed and what was not.
async function tell(cup, message) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    if (new URL(client.url).pathname === `/demo/${cup}/`) client.postMessage(message);
  }
}
