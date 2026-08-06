import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------- 响应辅助（支持 Gzip 压缩） ----------
function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

function writeRes(req, res, status, body, contentType, extraHeaders = {}) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
  if (acceptsGzip(req) && body.length > 512) {
    const gz = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
  } else {
    headers['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(status, headers);
    res.end(body);
  }
}

export function sendJson(req, res, status, data) {
  writeRes(req, res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

export function sendText(req, res, status, text, contentType = 'text/plain; charset=utf-8') {
  writeRes(req, res, status, String(text), contentType);
}

export function sendError(req, res, status, message, extra = {}) {
  sendJson(req, res, status, { ok: false, error: message, ...extra });
}

export function readBody(req, { limit = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 极简路由：支持 :param 段，例如 /api/rules/:id */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const segs = pattern.split('/').filter(Boolean);
    this.routes.push({ method: method.toUpperCase(), segs, handler, raw: pattern });
  }

  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  match(method, url) {
    const urlPath = decodeURIComponent(url.pathname || '/');
    const segs = urlPath.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segs.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = route.segs[i];
        if (p.startsWith(':')) params[p.slice(1)] = segs[i];
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  async handle(req, res, context) {
    const url = new URL(req.url, 'http://localhost');
    const match = this.match(req.method, url);
    if (!match) return false;
    req.params = match.params;
    await match.handler(req, res, { ...context, params: match.params, url });
    return true;
  }
}

/** 静态资源：优先返回内嵌资源（单文件二进制自包含），否则从磁盘读取；带缓存头，防止路径穿越。 */
export function staticHandler(rootDir, { embedded = {} } = {}) {
  const root = path.resolve(rootDir);
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const key = p.replace(/^\//, '');
    const embeddedBody = embedded[key];
    if (embeddedBody !== undefined) {
      const ext = path.extname(key).toLowerCase();
      const cache = 'no-cache';
      writeRes(req, res, 200, embeddedBody, MIME[ext] || 'text/plain; charset=utf-8', {
        'Cache-Control': cache,
      });
      return;
    }
    let file;
    try {
      file = path.join(root, path.normalize(p));
      if (!file.startsWith(root)) return sendError(req, res, 403, '禁止访问');
    } catch {
      return sendError(req, res, 404, 'Not Found');
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return sendError(req, res, 404, 'Not Found');
    }
    if (!stat.isFile()) return sendError(req, res, 404, 'Not Found');
    const ext = path.extname(file).toLowerCase();
    const cache = 'no-cache';
    writeRes(req, res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream', {
      'Cache-Control': cache,
      'ETag': `"${stat.size}-${Math.floor(stat.mtimeMs)}"`,
    });
  };
}
