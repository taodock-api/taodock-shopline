import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { shoplineClient, taodockClient } from '../src/clients.mjs';
import { checkFacts, previewText, readFacts } from '../src/facts.mjs';
import { createApp } from '../src/server.mjs';

const id = '16050375155238626683133099';
const appOrigin = 'http://catalog.test';
const base = '/admin/openapi/v20260901';
const listing = `${base}/products/products.json`;
const detail = `${base}/products/${id}.json`;
const modelId = 'shopline-test/model';
const password = 'local-integration-password';
const draftInput = { productId: id, measurements: '500 ml', phrases: 'navy blue', model: modelId };

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, { generated = 'A navy blue bottle with a 0.5 L capacity.' } = {}) {
  const requests = [];
  const transports = [];
  const flags = [];
  const product = {
    id,
    title: 'Steel bottle',
    spu: 'SG-SKU-1',
    status: 'draft',
    body_html: '<p>Old description &amp; details</p><script>window.alert(1)</script>',
    updated_at: '2026-11-25T00:00:00Z',
  };

  const upstream = await listen(createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake-upstream');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ url, body, method: request.method, auth: request.headers.authorization });

    let payload;
    if (url.pathname === listing) {
      payload = { products: [product] };
      if (!url.searchParams.has('page_info')) {
        response.setHeader('link', `<https://fictional.myshopline.com${listing}?limit=20&page_info=abc%2Bxyz>; rel="next"`);
      }
    } else if (url.pathname === detail) {
      if (request.method === 'PUT') {
        product.body_html = body.product.body_html;
        product.updated_at = '2026-11-25T00:01:00Z';
      }
      payload = { product };
    } else if (url.pathname === '/v1/models') {
      payload = { data: [{ id: modelId }, { id: modelId }] };
    } else if (url.pathname === '/v1/chat/completions') {
      payload = { choices: [{ message: { content: generated } }] };
    } else {
      response.statusCode = 404;
      payload = { error: 'no test endpoint' };
    }

    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(payload));
  }), t);

  const fetchImpl = (target, options) => {
    const url = new URL(target);
    transports.push({ origin: url.origin, redirect: options.redirect });
    return fetch(upstream + url.pathname + url.search, options);
  };

  const app = await listen(createApp({
    origin: appOrigin,
    password,
    store: shoplineClient({ storeHandle: 'fictional', token: 'shopline-fixture', fetchImpl }),
    generator: taodockClient({ token: 'taodock-fixture', fetchImpl }),
    async recordFlag(event) { flags.push(event); },
  }), t);

  function call(path, { body, origin = appOrigin, authorized = true, host = 'catalog.test' } = {}) {
    return new Promise((resolve, reject) => {
      const connection = request(app + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Host: host,
          ...(authorized && { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` }),
          ...(body !== undefined && { Origin: origin, 'Content-Type': 'application/json' }),
        },
      }, async (response) => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          const text = Buffer.concat(chunks).toString();
          const payload = response.headers['content-type'].startsWith('application/json')
            ? JSON.parse(text) : text;
          resolve({ status: response.statusCode, headers: new Headers(response.headers), payload });
        } catch (error) {
          reject(error);
        }
      });
      connection.on('error', reject);
      connection.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  return { call, flags, product, requests, transports };
}

test('quantity equivalence and literal attributes preserve approved facts', () => {
  const facts = readFacts({ measurements: '1.25 L\n1 kg\n60 min', phrases: 'navy blue\nUSB-C+' });
  assert.deepEqual(checkFacts(facts, 'Navy　blue, USB-C+ rated, 1,250 ml, １０００ g and 1 hr.'), []);
  assert.deepEqual(checkFacts(facts, 'SKU-1KG and 1/2 L.'), [
    { kind: 'missing', value: '1.25 L' },
    { kind: 'missing', value: '1 kg' },
    { kind: 'missing', value: '60 min' },
    { kind: 'phrase', value: 'navy blue' },
    { kind: 'phrase', value: 'USB-C+' },
  ]);
  assert.throws(() => readFacts({ measurements: '1,5 L', phrases: '' }), /supported unit/);
  assert.equal(previewText('<div>Plain &amp; safe</div><script>secret</script>'), 'Plain & safe');
});

test('serves the UI and protects the catalogue and write endpoints', async (t) => {
  const { call, requests } = await setup(t);
  const unauthorized = await call('/', { authorized: false });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /Basic realm=/u);
  assert.equal((await call('/api/models', { host: 'other.test' })).status, 403);
  assert.equal((await call('/api/drafts', { body: draftInput, origin: 'http://other.test' })).status, 403);
  assert.equal(requests.length, 0);
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.payload, /Catalog Review/u);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.match((await call('/app.mjs')).payload, /generateBatch/u);
});

test('lists paginated products and the current key model IDs', async (t) => {
  const { call, requests, transports } = await setup(t);
  const first = await call('/api/products?title=Steel');
  assert.equal(first.payload.products[0].id, id);
  assert.equal(first.payload.products[0].bodyHtml, '');
  assert.equal(first.payload.next, 'abc+xyz');
  const second = await call('/api/products?cursor=abc%2Bxyz&title=Steel');
  assert.equal(second.payload.next, '');
  assert.equal(requests[0].url.searchParams.get('title'), 'Steel');
  assert.equal(requests[1].url.searchParams.get('page_info'), 'abc+xyz');
  assert.equal(requests[1].url.searchParams.has('title'), false);
  assert.equal(requests[0].auth, 'Bearer shopline-fixture');
  assert.deepEqual((await call('/api/models')).payload.models, [modelId]);
  assert.equal(requests.at(-1).auth, 'Bearer taodock-fixture');
  assert.equal(transports[0].origin, 'https://fictional.myshopline.com');
  assert.equal(transports.at(-1).origin, 'https://taodock.com');
  assert.ok(transports.every(({ redirect }) => redirect === 'error'));
});

test('generates, checks, saves and verifies only the confirmed description', async (t) => {
  const { call, product, requests } = await setup(t);
  const created = await call('/api/drafts', { body: draftInput });
  assert.equal(created.status, 201);
  const draft = created.payload;
  assert.equal(draft.current, 'Old description & details');
  assert.deepEqual(draft.findings, []);
  assert.equal(requests.filter(({ method }) => method === 'PUT').length, 0);

  const sent = requests.find(({ url }) => url.pathname === '/v1/chat/completions');
  assert.equal(sent.body.model, modelId);
  assert.deepEqual(JSON.parse(sent.body.messages[1].content), {
    product: 'Steel bottle', approved_measurements: ['500 ml'], required_phrases: ['navy blue'],
  });

  const apply = `/api/drafts/${draft.id}/apply`;
  const unchecked = await call(apply, { body: { revision: 1, confirm: false } });
  assert.equal(unchecked.status, 400);
  const result = await call(apply, { body: { revision: 1, confirm: true } });
  assert.equal(result.status, 200);
  assert.ok(result.payload.receipt.savedAt);

  const writes = requests.filter(({ method }) => method === 'PUT');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, {
    product: { body_html: '<p>A navy blue bottle with a 0.5 L capacity.</p>' },
  });
  assert.equal(product.title, 'Steel bottle');
  assert.equal(product.status, 'draft');
  assert.equal(requests.at(-1).method, 'GET');
  const retry = await call(apply, { body: { revision: 1, confirm: true } });
  assert.deepEqual(retry.payload.receipt, result.payload.receipt);
  assert.equal(requests.filter(({ method }) => method === 'PUT').length, 1);
});

test('blocks numeric differences and flags, then escapes corrected plain text', async (t) => {
  const { call, product, requests, flags } = await setup(t, { generated: 'A navy blue 900 ml bottle.' });
  const { payload: draft } = await call('/api/drafts', { body: draftInput });
  assert.deepEqual(draft.findings.map(({ kind }) => kind), ['missing', 'extra']);
  const path = `/api/drafts/${draft.id}`;
  assert.equal((await call(`${path}/apply`, { body: { revision: 1, confirm: true } })).status, 409);
  assert.equal((await call(`${path}/flag`, { body: { revision: 1, reason: 'inaccurate' } })).payload.flagged, true);
  assert.equal(flags.length, 1);
  assert.deepEqual(Object.keys(flags[0]).sort(), ['productId', 'reason', 'revision', 'timestamp']);

  const checked = await call(`${path}/review`, {
    body: { revision: 1, draft: 'A navy blue 500 ml bottle. <em>Handle with care</em>' },
  });
  assert.equal(checked.payload.revision, 2);
  assert.equal(checked.payload.flagged, false);
  assert.deepEqual(checked.payload.findings, []);
  assert.equal((await call(`${path}/apply`, { body: { revision: 1, confirm: true } })).status, 409);
  assert.equal((await call(`${path}/apply`, { body: { revision: 2, confirm: true } })).status, 200);
  assert.equal(product.body_html, '<p>A navy blue 500 ml bottle. &lt;em&gt;Handle with care&lt;/em&gt;</p>');
  assert.equal(requests.filter(({ method }) => method === 'PUT').length, 1);
});

test('detects a newer SHOPLINE description and leaves it in place', async (t) => {
  const { call, product, requests } = await setup(t);
  const { payload: draft } = await call('/api/drafts', { body: draftInput });
  product.body_html = '<p>Changed in the store.</p>';
  const stale = await call(`/api/drafts/${draft.id}/apply`, { body: { revision: 1, confirm: true } });
  assert.equal(stale.status, 409);
  assert.match(stale.payload.error, /changed in SHOPLINE/u);
  assert.equal(requests.filter(({ method }) => method === 'PUT').length, 0);
  assert.equal(product.body_html, '<p>Changed in the store.</p>');
});

test('rejects invented model IDs before invoking Chat Completions', async (t) => {
  const { call, requests } = await setup(t);
  const result = await call('/api/drafts', { body: { ...draftInput, model: 'unchecked-model' } });
  assert.equal(result.status, 400);
  assert.equal(requests.filter(({ url }) => url.pathname === '/v1/chat/completions').length, 0);
});
