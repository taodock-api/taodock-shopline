import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { shoplineClient, taodockClient } from './clients.mjs';
import { demoClients } from './demo.mjs';
import { AppError } from './errors.mjs';
import { reviewService } from './reviews.mjs';

const staticAssets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
].map(([path, [file, type]]) => [
  path, { type, body: readFileSync(new URL(`../public/${file}`, import.meta.url)) },
]));
const draftRoute = /^\/api\/drafts\/([A-Za-z0-9_-]{32})\/(review|flag|apply)$/u;
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

async function jsonRequest(request) {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) {
    throw new AppError(415, 'Send a JSON request.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 32_768) {
      request.resume();
      throw new AppError(413, 'The request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  } catch {
    // Invalid JSON and non-object payloads use the same response.
  }
  throw new AppError(400, 'Enter a valid JSON object.');
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

export function createApp({ origin, password, demo = false, store, generator, recordFlag }) {
  const allowed = new URL(origin);
  const expected = password ? digest(`admin:${password}`) : null;
  const reviews = reviewService({ store, generator, recordFlag });

  return createServer({ requestTimeout: 70_000 }, async (request, response) => {
    try {
      const url = new URL(request.url, allowed);
      if (request.method === 'GET' && request.url === '/healthz') {
        return send(response, 200, { status: 'ok' });
      }
      if (request.headers.host !== allowed.host || url.origin !== allowed.origin) {
        throw new AppError(403, 'This host is outside the configured application origin.');
      }
      if (expected) {
        const supplied = /^Basic ([A-Za-z0-9+/]+=*)$/iu.exec(request.headers.authorization ?? '');
        if (!supplied || !timingSafeEqual(digest(Buffer.from(supplied[1], 'base64')), expected)) {
          return send(response, 401, { error: 'Sign in to access the catalogue.' }, {
            'WWW-Authenticate': 'Basic realm="Taodock Catalog Review", charset="UTF-8"',
          });
        }
      }

      if (request.method === 'GET') {
        const asset = staticAssets.get(url.pathname);
        if (asset) {
          response.writeHead(200, { ...securityHeaders, 'Content-Type': asset.type });
          return response.end(asset.body);
        }
        if (url.pathname === '/api/products') {
          const title = (url.searchParams.get('title') ?? '').trim();
          const cursor = url.searchParams.get('cursor') ?? '';
          if (title.length > 255 || cursor.length > 4096) {
            throw new AppError(400, 'The catalogue query is too long.');
          }
          return send(response, 200, { demo, ...await store.list({ title, cursor }) });
        }
        if (url.pathname === '/api/models') {
          return send(response, 200, { models: await generator.models() });
        }
      }

      if (request.method === 'POST') {
        if (request.headers.origin !== allowed.origin) {
          throw new AppError(403, 'Send changes from the configured application origin.');
        }
        if (url.pathname === '/api/drafts') {
          return send(response, 201, await reviews.generate(await jsonRequest(request)));
        }
        const route = draftRoute.exec(url.pathname);
        if (route) {
          const [, id, action] = route;
          const input = await jsonRequest(request);
          if (action === 'review') return send(response, 200, reviews.edit(id, input));
          if (action === 'flag') return send(response, 200, await reviews.flag(id, input));
          return send(response, 200, await reviews.apply(id, input));
        }
      }

      return send(response, 404, { error: 'Page not found.' });
    } catch (error) {
      if (error instanceof AppError) return send(response, error.status, { error: error.message });
      return send(response, 500, { error: 'The operation could not be completed.' });
    }
  });
}

function start() {
  const demo = process.argv.includes('--demo');
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set a valid PORT.');
  const origin = new URL(process.env.APP_ORIGIN || `http://127.0.0.1:${port}`);
  if (origin.origin !== origin.href.slice(0, -1) || !['https:', 'http:'].includes(origin.protocol)) {
    throw new Error('Set APP_ORIGIN to the application origin with no path.');
  }
  const loopback = ['127.0.0.1', 'localhost'].includes(origin.hostname);
  if ((!loopback && origin.protocol !== 'https:') || (demo && !loopback)) {
    throw new Error('Use HTTPS for a remote origin and localhost for demo mode.');
  }
  const password = process.env.APP_PASSWORD;
  if (!demo && (!password || password.length < 16)) {
    throw new Error('Set APP_PASSWORD to at least 16 characters.');
  }
  const directory = resolve(process.env.APP_DATA_DIR || '.taodock-data');
  const services = demo ? demoClients() : {
    store: shoplineClient({
      storeHandle: process.env.SHOPLINE_STORE_HANDLE,
      token: process.env.SHOPLINE_ACCESS_TOKEN,
    }),
    generator: taodockClient({ token: process.env.TAODOCK_API_KEY }),
    async recordFlag(event) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(resolve(directory, 'flags.jsonl'), JSON.stringify(event) + '\n', {
        encoding: 'utf8', mode: 0o600,
      });
    },
  };

  const app = createApp({ origin: origin.origin, password, demo, ...services });
  app.listen(port, '127.0.0.1', () => {
    console.log(`Taodock Catalog Review listening at ${origin.origin}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    start();
  } catch (error) {
    console.error(error instanceof TypeError ? 'Check APP_ORIGIN and the environment settings.' : error.message);
    process.exitCode = 1;
  }
}
