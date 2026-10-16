// Names a request to a Cup's worker. The capture command (Node) and the replay
// worker (browser) both load this one file, so a recording is always looked up
// by the name it was saved under.
//
// A name is the method, the path, the query in sorted order and the body: JSON
// with sorted keys, or a short digest of anything else, so an uploaded sample
// matches only its own recording. Identifiers that change on every run (a job
// number the page makes up, a map pack's session id) are written as :id.
(function (root) {
  const VOLATILE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{32}\b/gi;
  const sorted = (value) => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
    : value;
  async function digest(buffer) {
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(hash)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  root.demoKey = async function ({ method, path, search = '', type = '', body = null }) {
    const query = [...new URLSearchParams(search)].map(([name, value]) => `${name}=${value}`).sort().join('&');
    let tail = '';
    if (body && body.byteLength) {
      tail = ` #${await digest(body)}`;
      if (/json/.test(type)) {
        try { tail = ` ${JSON.stringify(sorted(JSON.parse(new TextDecoder().decode(body))))}`; } catch { /* Not JSON after all: the digest stands. */ }
      }
    }
    return `${method} ${path}${query ? `?${query}` : ''}${tail}`.replace(VOLATILE, ':id');
  };
})(globalThis);
