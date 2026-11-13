// New quotes store one perspective JPEG and a short ?d= permalink.
// Run: node --experimental-sqlite --test worker/onephoto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = { style: 'gable', w: 10, l: 12, h: 8 };
const JPEG = 'data:image/jpeg;base64,QQ==';

function makeD1(db) {
  function shape(sql) {
    const st = db.prepare(sql);
    const sel = /^\s*(select|pragma)/i.test(sql);
    return (a) => ({
      first() { return sel ? (st.get(...a) ?? null) : (st.run(...a), null); },
      all() { return { results: st.all(...a) }; },
      run() {
        if (sel) return { results: st.all(...a) };
        const r = st.run(...a);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      }
    });
  }
  return {
    prepare(sql) { const m = shape(sql); return { ...m([]), bind: (...a) => m(a) }; },
    async batch(st) { return st.map((x) => x.run()); }
  };
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
  const puts = [];
  const env = {
    DB: makeD1(db),
    CRM_DB: makeD1(new DatabaseSync(':memory:')),
    ADMIN_PASSWORD: 'pw',
    ADMIN_SESSION_SECRET: 'k',
    RENDERS: {
      async put(key, bytes, opts) { puts.push({ key, size: bytes.length, type: opts && opts.httpMetadata && opts.httpMetadata.contentType }); }
    },
    RENDERS_PUBLIC_BASE: 'https://pub-test.r2.dev'
  };
  async function call(method, path, body, token) {
    const headers = { Origin: 'https://shedpro-utah.com', 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await worker.fetch(new Request('https://x' + path, {
      method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {})
    }), env);
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  return { db, env, puts, call };
}

test('a quote submitted without a permalink still gets a short ?d= link', async () => {
  const { db, call } = setup();
  const r = await call('POST', '/shed/submit', {
    contact: { name: 'Test Onephoto', email: 'onephoto@example.test', phone: '4355550100' },
    config: CFG
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = db.prepare('SELECT details FROM submissions ORDER BY id DESC LIMIT 1').get();
  const d = JSON.parse(row.details);
  assert.match(d.permalink, /^https:\/\/www\.shedpro-utah\.com\/designer\.html\?d=[0-9a-f]{32}$/);
  const code = d.permalink.split('d=')[1];
  const saved = db.prepare('SELECT config FROM saved_designs WHERE code = ?').get(code);
  assert.ok(saved, 'saved_designs row exists');
  assert.equal(JSON.parse(saved.config).w, 10);
});

test('an existing short permalink is reused, not minted again', async () => {
  const { db, call } = setup();
  const first = await call('POST', '/shed/design', { config: CFG });
  assert.equal(first.status, 200);
  const code = first.data.code;
  const before = db.prepare('SELECT COUNT(*) n FROM saved_designs').get().n;
  const r = await call('POST', '/shed/submit', {
    contact: { name: 'Reuse', email: 'reuse@example.test', phone: '4355550101' },
    config: CFG,
    permalink: 'https://www.shedpro-utah.com/designer.html?d=' + code
  });
  assert.equal(r.status, 200);
  const d = JSON.parse(db.prepare('SELECT details FROM submissions ORDER BY id DESC LIMIT 1').get().details);
  assert.equal(d.permalink, 'https://www.shedpro-utah.com/designer.html?d=' + code);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM saved_designs').get().n, before);
});

test('only the perspective JPEG is uploaded, even if five views are sent', async () => {
  const { db, puts, call } = setup();
  const views = ['perspective', 'front', 'right', 'back', 'left'].map((view) => ({ view, dataUrl: JPEG }));
  const r = await call('POST', '/shed/submit', {
    contact: { name: 'Five', email: 'five@example.test', phone: '4355550102' },
    config: CFG,
    renders: views
  });
  assert.equal(r.status, 200);
  assert.equal(puts.length, 1);
  assert.match(puts[0].key, /-perspective\.jpg$/);
  const d = JSON.parse(db.prepare('SELECT details FROM submissions ORDER BY id DESC LIMIT 1').get().details);
  assert.deepEqual(Object.keys(d.renders || {}), ['perspective']);
  assert.match(d.renders.perspective, /^https:\/\/pub-test\.r2\.dev\/submissions\/.+-perspective\.jpg$/);
});

test('a consult with a started design also gets a short permalink', async () => {
  const { db, call } = setup();
  const r = await call('POST', '/shed/consult', {
    contact: { name: 'Call Me', email: 'call@example.test', phone: '4355550103' },
    step: 'Size',
    stepIndex: 2,
    config: CFG
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = JSON.parse(db.prepare('SELECT details FROM submissions ORDER BY id DESC LIMIT 1').get().details);
  assert.match(d.permalink, /designer\.html\?d=[0-9a-f]{32}$/);
});
