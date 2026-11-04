// Access kuralları testi: plan koleksiyonu ve servis anahtarı. Çalıştır: cd int/api && node --test test/plan-access.test.mjs
// Gerçek Cloudflare gerekmez: Access sertifikaları ve D1 sahtedir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-access-')), 'worker.mjs');
fs.copyFileSync(path.join(here, '..', 'src', 'index.js'), tmp); // .js → .mjs: paket türüne bağlı kalma
const worker = (await import(pathToFileURL(tmp).href)).default;

const TEAM = 'team.example.cloudflareaccess.com';
const AUD = 'aud-1';
const keys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
globalThis.fetch = async (url) => {
  if (String(url) === 'https://' + TEAM + '/cdn-cgi/access/certs') return new Response(JSON.stringify({ keys: [jwk] }));
  throw new Error('beklenmeyen fetch: ' + url);
};

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
async function jwt(claims) {
  const head = b64({ alg: 'RS256', kid: 'k1' });
  const body = b64({ iss: 'https://' + TEAM, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(head + '.' + body)));
  return head + '.' + body + '.' + sig.toString('base64url');
}

function fakeDb() {
  const rows = new Map();
  const k = (c, i) => c + '\u0000' + i;
  const stmt = (sql) => ({
    bind(...a) {
      return {
        async run() {
          if (sql.startsWith('INSERT INTO docs')) {
            const cur = rows.get(k(a[0], a[1]));
            rows.set(k(a[0], a[1]), { id: a[1], data: a[2], version: cur ? cur.version + 1 : 1 });
          } else if (sql.startsWith('DELETE')) rows.delete(k(a[0], a[1]));
          else if (sql.startsWith('UPDATE docs')) { // data, now, email, col, id, ifVersion
            const cur = rows.get(k(a[3], a[4]));
            if (!cur || cur.version !== a[5]) return { meta: { changes: 0 } };
            rows.set(k(a[3], a[4]), { id: a[4], data: a[0], version: cur.version + 1 });
          }
          return { meta: { changes: 1 } };
        },
        async first() { return rows.get(k(a[0], a[1])) || null; },
        async all() { return { results: [...rows.entries()].filter(([x]) => x.startsWith(a[0] + '\u0000')).map(([, v]) => v) }; },
      };
    },
  });
  return { prepare: stmt, async batch() {} };
}

const env = () => ({ DB: fakeDb(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: 'boss@example.com', PLAN_SERVICE_ID: 'ABC123.access' });
async function call(e, method, p, token, body) {
  const headers = token ? { 'Cf-Access-Jwt-Assertion': token } : {};
  const r = await worker.fetch(new Request('https://deltaxgames.com' + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), e, {});
  return r.status;
}

test('giriş şart', async () => {
  assert.equal(await call(env(), 'GET', '/int/api/plan/current'), 401);
});

test('insan: herkes okur, yalnızca yönetici plan yazar, finans bozulmadı', async () => {
  const e = env();
  const editor = await jwt({ email: 'friend@example.com' });
  const admin = await jwt({ email: 'Boss@Example.com' });
  assert.equal(await call(e, 'GET', '/int/api/plan/current', editor), 404);
  assert.equal(await call(e, 'PUT', '/int/api/plan/current', editor, { data: { a: 1 } }), 403);
  assert.equal(await call(e, 'PUT', '/int/api/plan/current', admin, { data: { a: 1 } }), 200);
  assert.equal(await call(e, 'GET', '/int/api/plan/current', editor), 200);
  assert.equal(await call(e, 'PUT', '/int/api/transactions/t1', editor, { data: { amount: 5 } }), 200); // eskisi gibi
  assert.equal(await call(e, 'PUT', '/int/api/accounts/a1', editor, { data: {} }), 403);               // eskisi gibi
});

test('servis anahtarı: yalnızca plan/current GET ve PUT', async () => {
  const e = env();
  const svc = await jwt({ common_name: 'ABC123.access', type: 'app' });
  assert.equal(await call(e, 'PUT', '/int/api/plan/current', svc, { data: { ok: true } }), 200);
  assert.equal(await call(e, 'GET', '/int/api/plan/current', svc), 200);
  for (const [m, p, b] of [
    ['PUT', '/int/api/plan/other', { data: {} }], ['DELETE', '/int/api/plan/current'], ['GET', '/int/api/plan'],
    ['POST', '/int/api/plan', { data: {} }], ['GET', '/int/api/transactions'], ['GET', '/int/api/transactions/t1'],
    ['PUT', '/int/api/transactions/t1', { data: {} }], ['PUT', '/int/api/settings/s', { data: {} }],
    ['GET', '/int/api/me'], ['POST', '/int/api/_import', { docs: [] }], ['POST', '/int/api/_rates/refresh'],
  ]) assert.equal(await call(e, m, p, svc, b), 403, m + ' ' + p);
});

test('yanlış ya da tanımsız servis anahtarı geçmez', async () => {
  const wrong = await jwt({ common_name: 'OTHER.access', type: 'app' });
  assert.equal(await call(env(), 'GET', '/int/api/plan/current', wrong), 401);
  const noId = { ...env(), PLAN_SERVICE_ID: undefined };
  assert.equal(await call(noId, 'GET', '/int/api/plan/current', await jwt({ common_name: 'ABC123.access' })), 401);
  assert.equal(await call(env(), 'GET', '/int/api/plan/current', await jwt({})), 401); // e-postasız, common_name'siz
});

test('plan/people: Access\'ten geçen herkes PUT eder, silemez; sürüm çakışması 409; servis anahtarı dokunamaz', async () => {
  const e = env();
  const editor = await jwt({ email: 'friend@example.com' });
  const svc = await jwt({ common_name: 'ABC123.access', type: 'app' });
  assert.equal(await call(e, 'GET', '/int/api/plan/people', editor), 404);
  assert.equal(await call(e, 'PUT', '/int/api/plan/people', editor, { data: { people: [] } }), 200);   // ilk yazım: sürüm 1
  assert.equal(await call(e, 'PUT', '/int/api/plan/people', editor, { data: { people: [] }, if_version: 1 }), 200);
  assert.equal(await call(e, 'PUT', '/int/api/plan/people', editor, { data: { people: [] }, if_version: 1 }), 409); // bayat sürüm
  assert.equal(await call(e, 'GET', '/int/api/plan/people', editor), 200);
  // istisna yalnızca plan/people'a ve yalnızca PUT'a geçerli
  assert.equal(await call(e, 'DELETE', '/int/api/plan/people', editor), 403);
  assert.equal(await call(e, 'PUT', '/int/api/plan/current', editor, { data: {} }), 403);
  assert.equal(await call(e, 'PUT', '/int/api/plan/other', editor, { data: {} }), 403);
  assert.equal(await call(e, 'POST', '/int/api/plan', editor, { data: {} }), 403);
  assert.equal(await call(e, 'PUT', '/int/api/accounts/a1', editor, { data: {} }), 403);
  // servis anahtarı yalnızca plan/current'a erişir
  assert.equal(await call(e, 'GET', '/int/api/plan/people', svc), 403);
  assert.equal(await call(e, 'PUT', '/int/api/plan/people', svc, { data: {} }), 403);
});
