const { exec } = require('../core/vmController');

const wsConnections = new Map();

async function Fetch({ url, method = 'GET', headers = {}, body }) {
  try {
    const opts = { method, headers };
    if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    return { ok: true, result: { status: res.status, body: text } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function WebSearch({ query, limit = 5 }) {
  // Use DuckDuckGo HTML endpoint as a no-key search
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'NomadAI/0.1' } });
    const html = await res.text();

    const results = [];
    const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
    const snippetRe = /class="result__snippet"[^>]*>([^<]+)</g;

    let match;
    const links = [];
    while ((match = linkRe.exec(html)) !== null) {
      links.push({ url: match[1], title: match[2].trim() });
    }

    const snippets = [];
    while ((match = snippetRe.exec(html)) !== null) {
      snippets.push(match[1].trim());
    }

    for (let i = 0; i < Math.min(limit, links.length); i++) {
      results.push({ ...links[i], snippet: snippets[i] || '' });
    }

    return { ok: true, result: results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function WebSocket({ url, onMessage }) {
  // In node environment, use native WebSocket (Node 22+) or skip
  return { ok: false, error: 'WebSocket connections require a running event loop context. Use HttpServer instead.' };
}

async function HttpServer({ port, handler }) {
  // handler is a string of JS code — eval it in context
  try {
    const fn = new Function('req', handler);
    const server = Bun.serve({
      port,
      fetch: async (req) => {
        try {
          const result = await fn(req);
          if (result instanceof Response) return result;
          return new Response(String(result));
        } catch (e) {
          return new Response(e.message, { status: 500 });
        }
      },
    });
    return { ok: true, result: `Server listening on port ${port}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function Ping({ host }) {
  const result = await exec(`ping -c 1 -W 2 "${host}" 2>&1`);
  const reachable = result.exitCode === 0;
  const latencyMatch = result.stdout.match(/time=(\d+\.?\d*)\s*ms/);
  return {
    ok: true,
    result: { reachable, latency: latencyMatch ? parseFloat(latencyMatch[1]) : null },
  };
}

module.exports = { Fetch, WebSearch, WebSocket, HttpServer, Ping };
