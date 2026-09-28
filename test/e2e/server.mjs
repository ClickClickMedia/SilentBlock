// Fixture server. The browser maps every hostname to 127.0.0.1, so one server answers
// for site.test, sb-ads.test, and so on; the Host header tells them apart.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');

export async function startServer() {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    hits.push(`${url.hostname}${url.pathname}${url.search}`);
    if (url.pathname.startsWith('/page/')) {
      try {
        const html = await readFile(path.join(FIXTURES, path.basename(url.pathname)), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404).end('not found');
      }
      return;
    }
    if (url.pathname.endsWith('.js') || url.pathname.startsWith('/gtag/') || url.pathname.startsWith('/script')) {
      // A script served for real records itself, so tests can tell "loaded" from "stubbed".
      const id = url.searchParams.get('id') || url.pathname;
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`(window.__real = window.__real || []).push(${JSON.stringify(id)});`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, hits, close: () => new Promise((r) => server.close(r)) };
}
