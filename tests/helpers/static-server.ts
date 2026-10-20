// A tiny static file server for dist/ that behaves like the production hosts (Cloudflare Pages, GitHub Pages):
//   • serves only under BASE_PATH (anything outside it is a 404, so links that forget the base are caught)
//   • "/dir/" → dir/index.html; "/dir" (no slash) → 301 to "/dir/" when dir/index.html exists
//   • unknown paths → 404 with dist/404.html as the body (if it exists)
// No dependencies; used by scripts/check-links.ts and scripts/capture-screenshots.ts (--serve).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { normalizeBase } from './env';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.pdf': 'application/pdf',
};

export interface StaticServer {
  /** Origin, e.g. http://127.0.0.1:53211 */
  origin: string;
  /** Origin + base path, always ending in "/". */
  url: string;
  server: Server;
  close(): Promise<void>;
}

export interface StaticServerOptions {
  root: string;
  basePath?: string;
  port?: number;
  host?: string;
}

export async function startStaticServer(opts: StaticServerOptions): Promise<StaticServer> {
  const root = resolve(opts.root);
  const base = normalizeBase(opts.basePath);
  const host = opts.host ?? '127.0.0.1';
  const notFoundPage = join(root, '404.html');

  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const u = new URL(req.url ?? '/', 'http://localhost');
    let pathname: string;
    try {
      pathname = decodeURIComponent(u.pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    const send = (file: string, status = 200) => {
      const st = statSync(file);
      res.writeHead(status, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
      });
      if (method === 'HEAD') res.end();
      else createReadStream(file).pipe(res);
    };
    const notFound = () => {
      if (isFile(notFoundPage)) send(notFoundPage, 404);
      else res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    };

    // Base path handling: "/repo" → "/repo/"; outside the base → 404.
    if (base !== '/' && pathname === base.slice(0, -1)) {
      res.writeHead(301, { Location: base + u.search }).end();
      return;
    }
    if (!pathname.startsWith(base)) return notFound();
    const rel = pathname.slice(base.length);
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) return notFound(); // traversal guard

    if (pathname.endsWith('/')) {
      const index = join(target, 'index.html');
      return isFile(index) ? send(index) : notFound();
    }
    if (isFile(target)) return send(target);
    if (existsSync(join(target, 'index.html'))) {
      res.writeHead(301, { Location: `${u.pathname}/${u.search}` }).end();
      return;
    }
    if (!extname(target) && isFile(`${target}.html`)) return send(`${target}.html`);
    return notFound();
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, host, () => ok());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://${host}:${port}`;
  return {
    origin,
    url: origin + base,
    server,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
