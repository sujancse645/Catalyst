/**
 * Minimal HTTP toolkit: router with :params, bounded JSON body parsing,
 * cookies, and a precompressed, ETag-cached static file server.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { HttpError } from './errors.js';

export function createRouter() {
  const routes = [];
  return {
    add(route) {
      const keys = [];
      const pattern = new RegExp(
        `^${route.path.replace(/:([a-zA-Z]+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        })}$`,
      );
      routes.push({ ...route, pattern, keys });
    },
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.pattern.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return { route: r, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

/** Read a JSON body with a hard size limit (defends against memory exhaustion). */
export function readJson(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limitBytes) {
      reject(new HttpError(413, 'That upload is too large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'That upload is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);

/**
 * Load every public file into memory once at startup with its ETag and a
 * gzip variant — zero disk I/O and zero compression work per request.
 */
export function createStaticServer(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const body = readFileSync(full);
        const ext = extname(name);
        const urlPath = `/${relative(root, full).split(sep).join('/')}`;
        files.set(urlPath, {
          body,
          gzip: COMPRESSIBLE.has(ext) && body.length > 512 ? gzipSync(body) : null,
          type: MIME[ext] || 'application/octet-stream',
          etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
          cache: ext === '.html' ? 'no-cache' : 'public, max-age=3600',
        });
      }
    }
  };
  walk(root);

  return function serve(req, res, pathname) {
    // Map is keyed by known paths only, so traversal like "/../x" can never resolve.
    const file = files.get(pathname) || (extname(pathname) ? null : files.get('/index.html'));
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const headers = { 'Content-Type': file.type, 'Cache-Control': file.cache, ETag: file.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const useGzip = file.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = useGzip ? file.gzip : file.body;
    res.writeHead(200, { ...headers, ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
