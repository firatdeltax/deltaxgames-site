/*
 * DeltaX Financial Tracker — API Worker.
 *
 * deltaxgames.com/int/api/* altında çalışır. Her istekte Cloudflare Access'in verdiği
 * imzalı kimliği (JWT) doğrular; Access'ten geçmemiş istek 401 alır. Veri D1'de,
 * "docs" tablosunda JSON belgeler olarak durur (bkz. schema.sql).
 *
 * Uç noktalar (hepsi JSON):
 *   GET    /int/api/me                      → { email, role: "admin" | "editor" }
 *   GET    /int/api/:collection             → { docs: [{ id, data, version }] }
 *   GET    /int/api/:collection/:id         → { id, data, version }   (yoksa 404)
 *   POST   /int/api/:collection             → body { data }                → { id, version }
 *   PUT    /int/api/:collection/:id         → body { data, if_version? }   → { id, version }  (çakışma: 409)
 *   DELETE /int/api/:collection/:id         → { ok: true }
 *   POST   /int/api/_import                 → body { docs: [{ collection, id, data }] }  (yalnızca yönetici)
 *   POST   /int/api/_rates/refresh          → TCMB'den bugünkü USD kurunu çeker            (yalnızca yönetici)
 *
 * accounts, categories, rates ve settings koleksiyonlarına yalnızca ADMIN_EMAILS'teki kişiler yazar;
 * transactions'a Access'ten geçen herkes yazar.
 */

const COLLECTIONS = new Set(['transactions', 'accounts', 'categories', 'rates', 'settings']);
const ADMIN_ONLY = new Set(['accounts', 'categories', 'rates', 'settings']);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC_BYTES = 256 * 1024;
const MAX_IMPORT = 2000;

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      return json({ error: 'Sunucu hatası', detail: String((e && e.message) || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshRates(env, 'cron'));
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/int\/api(?:\/(.*))?$/);
  if (!m) return json({ error: 'Bulunamadı' }, 404);
  const parts = (m[1] || '').split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (!env.DB) return json({ error: 'D1 veritabanı bağlı değil (wrangler.toml içindeki database_id)' }, 500);

  const user = await authenticate(request, env);
  if (!user) return json({ error: 'Giriş gerekli', code: 'auth' }, 401);

  const method = request.method.toUpperCase();
  const head = parts[0] || '';

  if (head === 'me') {
    if (method !== 'GET') return json({ error: 'Yöntem desteklenmiyor' }, 405);
    return json({ email: user.email, role: user.admin ? 'admin' : 'editor' });
  }

  if (head === '_import') {
    if (method !== 'POST') return json({ error: 'Yöntem desteklenmiyor' }, 405);
    if (!user.admin) return json({ error: 'Yalnızca yönetici içe aktarabilir', code: 'forbidden' }, 403);
    return importDocs(request, env, user.email);
  }

  if (head === '_rates' && parts[1] === 'refresh') {
    if (method !== 'POST') return json({ error: 'Yöntem desteklenmiyor' }, 405);
    if (!user.admin) return json({ error: 'Yalnızca yönetici kur yenileyebilir', code: 'forbidden' }, 403);
    return json(await refreshRates(env, user.email));
  }

  const col = head;
  const id = parts[1];
  if (!COLLECTIONS.has(col) || parts.length > 2) return json({ error: 'Bulunamadı' }, 404);
  if (id !== undefined && !ID_RE.test(id)) return json({ error: 'Geçersiz kayıt kimliği', code: 'invalid' }, 400);

  if (method === 'GET') {
    if (id === undefined) return json({ docs: await listDocs(env, col) });
    const doc = await getDoc(env, col, id);
    return doc ? json(doc) : json({ error: 'Kayıt yok', code: 'notfound' }, 404);
  }

  if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return json({ error: 'Yöntem desteklenmiyor' }, 405);
  if (ADMIN_ONLY.has(col) && !user.admin) {
    return json({ error: 'Bu alanı yalnızca yönetici değiştirebilir', code: 'forbidden' }, 403);
  }

  if (method === 'DELETE') {
    if (id === undefined) return json({ error: 'Kayıt kimliği gerekli', code: 'invalid' }, 400);
    await env.DB.prepare('DELETE FROM docs WHERE collection = ?1 AND id = ?2').bind(col, id).run();
    return json({ ok: true });
  }

  const body = await readJson(request);
  if (!body || !isPlainObject(body.data)) return json({ error: 'Gövde { data: {...} } olmalı', code: 'invalid' }, 400);
  const dataStr = JSON.stringify(body.data);
  if (dataStr.length > MAX_DOC_BYTES) return json({ error: 'Kayıt çok büyük', code: 'invalid' }, 400);

  if (method === 'POST') {
    if (id !== undefined) return json({ error: 'POST için kimlik verilmez', code: 'invalid' }, 400);
    const newId = newDocId();
    const r = await upsertDoc(env, col, newId, dataStr, user.email);
    return json(r, 201);
  }

  // PUT
  if (id === undefined) return json({ error: 'Kayıt kimliği gerekli', code: 'invalid' }, 400);
  const ifVersion = body.if_version == null ? null : Number(body.if_version);
  if (ifVersion != null && !Number.isInteger(ifVersion)) return json({ error: 'if_version tam sayı olmalı', code: 'invalid' }, 400);
  if (ifVersion == null) return json(await upsertDoc(env, col, id, dataStr, user.email));

  const now = new Date().toISOString();
  const upd = await env.DB
    .prepare('UPDATE docs SET data = ?1, version = version + 1, updated_at = ?2, updated_by = ?3 WHERE collection = ?4 AND id = ?5 AND version = ?6')
    .bind(dataStr, now, user.email, col, id, ifVersion)
    .run();
  if (upd.meta && upd.meta.changes > 0) return json({ id, version: ifVersion + 1 });
  const cur = await env.DB.prepare('SELECT version FROM docs WHERE collection = ?1 AND id = ?2').bind(col, id).first();
  if (!cur) return json({ error: 'Kayıt silinmiş', code: 'notfound' }, 404);
  return json({ error: 'Kayıt bu arada değişti', code: 'conflict', version: cur.version }, 409);
}

/* ---------- veri ---------- */

async function listDocs(env, col) {
  const { results } = await env.DB.prepare('SELECT id, data, version FROM docs WHERE collection = ?1 ORDER BY id').bind(col).all();
  return results.map((r) => ({ id: r.id, data: JSON.parse(r.data), version: r.version }));
}

async function getDoc(env, col, id) {
  const r = await env.DB.prepare('SELECT id, data, version FROM docs WHERE collection = ?1 AND id = ?2').bind(col, id).first();
  return r ? { id: r.id, data: JSON.parse(r.data), version: r.version } : null;
}

const UPSERT_SQL =
  'INSERT INTO docs (collection, id, data, version, updated_at, updated_by) VALUES (?1, ?2, ?3, 1, ?4, ?5) ' +
  'ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by';

async function upsertDoc(env, col, id, dataStr, by) {
  const now = new Date().toISOString();
  await env.DB.prepare(UPSERT_SQL).bind(col, id, dataStr, now, by).run();
  const cur = await env.DB.prepare('SELECT version FROM docs WHERE collection = ?1 AND id = ?2').bind(col, id).first();
  return { id, version: cur ? cur.version : 1 };
}

async function importDocs(request, env, by) {
  const body = await readJson(request);
  const docs = body && Array.isArray(body.docs) ? body.docs : null;
  if (!docs) return json({ error: 'Gövde { docs: [...] } olmalı', code: 'invalid' }, 400);
  if (docs.length > MAX_IMPORT) return json({ error: 'Tek seferde en çok ' + MAX_IMPORT + ' kayıt', code: 'invalid' }, 400);
  const now = new Date().toISOString();
  const stmts = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!d || !COLLECTIONS.has(d.collection) || typeof d.id !== 'string' || !ID_RE.test(d.id) || !isPlainObject(d.data)) {
      return json({ error: 'Geçersiz kayıt: #' + (i + 1), code: 'invalid' }, 400);
    }
    const s = JSON.stringify(d.data);
    if (s.length > MAX_DOC_BYTES) return json({ error: 'Kayıt çok büyük: #' + (i + 1), code: 'invalid' }, 400);
    stmts.push(env.DB.prepare(UPSERT_SQL).bind(d.collection, d.id, s, now, by));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, count: docs.length });
}

/* TCMB günlük kur: today.xml bültenin kendi tarihini taşır (hafta sonu son iş günü gelir). */
async function refreshRates(env, by) {
  let xml;
  try {
    const r = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml', { headers: { 'user-agent': 'deltax-finance/1.0' } });
    if (!r.ok) return { ok: false, error: 'TCMB yanıtı ' + r.status };
    xml = await r.text();
  } catch (e) {
    return { ok: false, error: 'TCMB erişilemedi: ' + String((e && e.message) || e) };
  }
  const dm = xml.match(/Tarih="(\d{2})\.(\d{2})\.(\d{4})"/);
  const um = xml.match(/CurrencyCode="USD"[\s\S]*?<ForexBuying>([\d.]+)<\/ForexBuying>\s*<ForexSelling>([\d.]+)<\/ForexSelling>/);
  if (!dm || !um) return { ok: false, error: 'Bültende USD kuru bulunamadı' };
  const date = dm[3] + '-' + dm[2] + '-' + dm[1];
  const buy = Number(um[1]);
  const sell = Number(um[2]);
  if (!(buy > 0) || !(sell > 0)) return { ok: false, error: 'Kur sayı değil' };
  const ym = date.slice(0, 7);
  const cur = await getDoc(env, 'rates', ym);
  const data = cur ? cur.data : {};
  if (Array.isArray(data[date]) && data[date][0] === buy && data[date][1] === sell) {
    return { ok: true, date, buy, sell, changed: false };
  }
  data[date] = [buy, sell];
  await upsertDoc(env, 'rates', ym, JSON.stringify(data), by);
  return { ok: true, date, buy, sell, changed: true };
}

/* ---------- Cloudflare Access kimlik doğrulama ---------- */

async function authenticate(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!team || !aud) throw new Error('ACCESS_TEAM_DOMAIN ve ACCESS_AUD gizli değerleri tanımlı değil');
  let token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    const cookie = request.headers.get('Cookie') || '';
    const cm = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    if (cm) token = cm[1];
  }
  if (!token) return null;
  const payload = await verifyAccessJwt(token, team, aud);
  if (!payload || typeof payload.email !== 'string') return null;
  const email = payload.email.trim().toLowerCase();
  const admins = String(env.ADMIN_EMAILS || '')
    .toLowerCase()
    .split(/[,\s;]+/)
    .filter(Boolean);
  return { email, admin: admins.includes(email) };
}

let certCache = { team: '', at: 0, keys: [] };

async function getAccessKeys(team, force) {
  const now = Date.now();
  if (!force && certCache.team === team && certCache.keys.length && now - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch('https://' + team + '/cdn-cgi/access/certs', { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) throw new Error('Access sertifikaları alınamadı: ' + r.status);
  const j = await r.json();
  certCache = { team, at: now, keys: Array.isArray(j.keys) ? j.keys : [] };
  return certCache.keys;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyAccessJwt(token, team, aud) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    const dec = new TextDecoder();
    header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
  } catch (e) {
    return null;
  }
  if (!header || header.alg !== 'RS256' || !header.kid) return null;

  let jwk = (await getAccessKeys(team, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getAccessKeys(team, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  if (payload.iss !== 'https://' + team) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  return payload;
}

/* ---------- yardımcılar ---------- */

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function newDocId() {
  const t = Date.now().toString(36);
  const r = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  return t + '-' + r;
}
