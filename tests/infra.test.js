import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bareAddress, buildMessage, createMailer, createSmtpTransport, sanitizeHeader } from '../server/lib/mailer.js';
import { createFirestoreStore, decodeFields, encodeFields } from '../server/lib/firestore.js';
import { createMemoryStore } from '../server/lib/store.js';

describe('email', () => {
  test('header injection is impossible', () => {
    assert.equal(sanitizeHeader('Hi\r\nBcc: evil@x.com'), 'Hi Bcc: evil@x.com');
    const raw = buildMessage({ from: 'a@b.co', to: ['c@d.co'], subject: 'Dose\r\nBcc: e@f.co', text: 'x' });
    assert.ok(!/^Bcc:/m.test(raw));
    assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  });

  test('message is valid multipart with both parts', () => {
    const raw = buildMessage({ from: 'SaathiCare <a@b.co>', to: ['c@d.co'], subject: 'नमस्ते', text: 'plain', html: '<p>h</p>' });
    assert.match(raw, /multipart\/alternative/);
    assert.equal((raw.match(/Content-Transfer-Encoding: base64/g) || []).length, 2);
    assert.ok(raw.includes(Buffer.from('plain').toString('base64')));
  });

  test('bareAddress extracts addresses', () => {
    assert.equal(bareAddress('SaathiCare <a@b.co>'), 'a@b.co');
    assert.equal(bareAddress('a@b.co'), 'a@b.co');
  });

  test('demo mode logs without sending and skips empty recipient lists', async () => {
    const store = createMemoryStore();
    const mailer = createMailer({ transport: null, store, from: 'x' });
    assert.equal(mailer.mode, 'demo');
    assert.equal((await mailer.send({ circleId: 'c', kind: 'k', to: [], subject: 's', text: 't' })).status, 'skipped');
    assert.equal((await mailer.send({ circleId: 'c', kind: 'k', to: ['a@b.co', 'a@b.co'], subject: 's', text: 't' })).status, 'logged');
    const [rec] = await store.find('outbox');
    assert.deepEqual(rec.to, ['a@b.co'], 'deduplicated');
  });

  test('SMTP transport speaks the protocol (fake server)', async () => {
    const written = [];
    const replies = {
      EHLO: '250-hello\r\n250 AUTH LOGIN\r\n',
      'AUTH LOGIN': '334 VXNlcm5hbWU6\r\n',
      MAIL: '250 ok\r\n',
      RCPT: '250 ok\r\n',
      DATA: '354 go\r\n',
    };
    let authStep = 0;
    const connectImpl = () => {
      const sock = new EventEmitter();
      sock.setEncoding = () => {};
      sock.setTimeout = () => {};
      sock.end = () => {};
      sock.destroy = () => {};
      sock.write = (line) => {
        written.push(line);
        const key = Object.keys(replies).find((k) => line.startsWith(k));
        let reply = key ? replies[key] : null;
        if (!key && authStep < 2) {
          authStep += 1;
          reply = authStep === 1 ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n';
        } else if (!key && line.endsWith('\r\n.\r\n')) reply = '250 queued\r\n';
        if (reply && !line.startsWith('QUIT')) setImmediate(() => sock.emit('data', reply));
      };
      setImmediate(() => sock.emit('data', '220 ready\r\n'));
      return sock;
    };
    const t = createSmtpTransport({ host: 'smtp.test', user: 'u', pass: 'p', connectImpl });
    await t.send({ from: 'A <a@b.co>', to: ['c@d.co'], raw: 'Subject: x\r\n\r\n.leading dot\r\n' });
    assert.ok(written.includes('MAIL FROM:<a@b.co>\r\n'));
    assert.ok(written.includes('RCPT TO:<c@d.co>\r\n'));
    assert.ok(written.some((w) => w.includes('\r\n..leading dot')), 'dot-stuffing');
  });

  test('SMTP errors surface as exceptions', async () => {
    const connectImpl = () => {
      const sock = new EventEmitter();
      Object.assign(sock, { setEncoding() {}, setTimeout() {}, end() {}, destroy() {}, write() {} });
      setImmediate(() => sock.emit('data', '554 go away\r\n'));
      return sock;
    };
    const t = createSmtpTransport({ host: 'h', connectImpl });
    await assert.rejects(t.send({ from: 'a@b.co', to: ['c@d.co'], raw: 'x' }), /expected 220/);
  });
});

describe('Firestore REST store', () => {
  test('encodes and decodes all value types losslessly', () => {
    const doc = { s: 'x', i: 3, d: 1.5, b: false, n: null, a: ['08:00', 2], m: { k: 'v', nested: { z: true } } };
    assert.deepEqual(decodeFields(encodeFields(doc)), doc);
  });

  test('talks to the documented REST endpoints with a metadata token', async () => {
    const calls = [];
    const docs = new Map();
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes('metadata.google.internal')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      }
      assert.equal(init.headers.Authorization, 'Bearer tok');
      if (url.endsWith(':runQuery')) {
        const rows = [...docs.values()].map((fields) => ({ document: { fields } }));
        return new Response(JSON.stringify([...rows, { readTime: 'x' }]));
      }
      const id = decodeURIComponent(url.split('/').pop().split('?')[0]);
      if (init.method === 'PATCH') {
        if (url.includes('currentDocument.exists=false') && docs.has(id)) return new Response('{}', { status: 409 });
        const { fields } = JSON.parse(init.body);
        docs.set(id, fields);
        return new Response(JSON.stringify({ fields }));
      }
      if (init.method === 'DELETE') return new Response('{}', { status: docs.delete(id) ? 200 : 404 });
      return docs.has(id) ? new Response(JSON.stringify({ fields: docs.get(id) })) : new Response('{}', { status: 404 });
    };
    const store = createFirestoreStore({ projectId: 'proj', fetchImpl });
    assert.equal(await store.get('c', 'none'), null);
    await store.set('c', 'a', { n: 1 });
    assert.deepEqual(await store.get('c', 'a'), { n: 1, id: 'a' });
    assert.equal(await store.setIfAbsent('c', 'a', { n: 2 }), false);
    assert.equal(await store.setIfAbsent('c', 'b', { n: 2 }), true);
    assert.deepEqual(await store.update('c', 'a', { k: 'v' }), { n: 1, k: 'v', id: 'a' });
    assert.equal(await store.update('c', 'zzz', { k: 'v' }), null);
    assert.equal((await store.find('c', { n: 2, id: 'b' })).length, 2, 'query rows decoded');
    assert.equal(await store.delete('c', 'a'), true);
    const query = calls.find((c) => c.url.endsWith(':runQuery'));
    assert.match(query.url, /projects\/proj\/databases\/\(default\)\/documents:runQuery$/);
    assert.equal(JSON.parse(query.init.body).structuredQuery.where.compositeFilter.op, 'AND');
    assert.equal(calls.filter((c) => c.url.includes('metadata')).length, 1, 'token is cached');
  });

  test('requires a project id', () => {
    assert.throws(() => createFirestoreStore({ projectId: '' }), /GOOGLE_CLOUD_PROJECT/);
  });
});

describe('memory store', () => {
  test('returns copies, so callers cannot mutate stored data', async () => {
    const s = createMemoryStore();
    const doc = await s.set('c', '1', { list: [1] });
    doc.list.push(2);
    assert.deepEqual((await s.get('c', '1')).list, [1]);
  });

  test('persists to a JSON file atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-'));
    const file = join(dir, 'data.json');
    try {
      const a = createMemoryStore({ file });
      await a.set('c', '1', { v: 'kept' });
      await new Promise((r) => setTimeout(r, 300));
      const b = createMemoryStore({ file });
      assert.equal((await b.get('c', '1')).v, 'kept');
      assert.equal(await b.delete('c', '1'), true);
      assert.equal(await b.delete('c', '1'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
