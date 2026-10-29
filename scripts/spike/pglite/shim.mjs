// PostgREST-subset -> SQL shim over PGlite. `createShim(db)` returns a fetch-compatible function.
// Values are collected per request and bound as $n parameters (see lit/exec); roles and claims come from a verified HS256 JWT.
import crypto from 'node:crypto';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (s) => { if (!IDENT.test(s)) throw httpErr(400, 'PGRST100', `bad identifier ${s}`); return `"${s}"`; };
// lit() returns a marker; exec() rewrites markers to dense $1..$k and sends the values as bound parameters.
// Handlers run one at a time inside a PGlite transaction (which holds its lock), so module-level state is safe.
let BIND = new Map(); let BIND_N = 0;
const lit = (v) => { if (v === null || v === undefined) return 'null'; const k = ++BIND_N; BIND.set(k, String(v)); return `\u27e6${k}\u27e7`; };
function bind(sql) {
  const order = []; const idx = new Map();
  const out = sql.replace(/\u27e6(\d+)\u27e7/g, (_, k) => { if (!idx.has(k)) { order.push(BIND.get(Number(k))); idx.set(k, order.length); } return '$' + idx.get(k); });
  return { sql: out, params: order };
}

// ---- JWT (HS256) ----
const b64u = (b) => Buffer.from(b).toString('base64url');
export function signJwt(claims, secret) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
export function verifyJwt(token, secret) {
  const parts = String(token || '').split('.'); if (parts.length !== 3) throw httpErr(401, 'PGRST301', 'JWSError CompactDecodeError');
  const hdr = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (hdr.alg !== 'HS256') throw httpErr(401, 'PGRST301', 'unsupported alg');
  const want = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest(); const got = Buffer.from(parts[2], 'base64url');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw httpErr(401, 'PGRST301', 'JWSError JWSInvalidSignature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (claims.exp && claims.exp < Date.now() / 1000) throw httpErr(401, 'PGRST301', 'JWT expired');
  return claims;
}
const ROLES = new Set(['anon', 'authenticated', 'service_role']);
const jlit = (v) => lit(JSON.stringify(v));
const httpErr = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

// ---- select list with embedded resources: "a, b, rel(x, y), alias:rel!inner(*)" ----
function splitTop(s, sep = ',') {
  const out = []; let d = 0, cur = '';
  for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === sep && d === 0) { out.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) out.push(cur); return out.map((x) => x.trim()).filter(Boolean);
}
export function parseSelect(sel) {
  return splitTop(sel || '*').map((item) => {
    const m = item.match(/^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)(?:!([A-Za-z_]\w*))?(?:!([A-Za-z_]\w*))?\((.*)\)$/s);
    if (m) {
      const mods = [m[3], m[4]].filter(Boolean);
      return { rel: m[2], alias: m[1] || m[2], inner: mods.includes('inner'), hint: mods.find((x) => x !== 'inner' && x !== 'left'), children: parseSelect(m[5]) };
    }
    const c = item.match(/^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*|\*)(?:::\w+)?$/);
    if (!c) throw httpErr(400, 'PGRST100', `unsupported select item ${item}`);
    return { col: c[2], alias: c[1] || c[2] };
  });
}

// ---- filters ----
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
function condition(col, expr, neg = false) {
  // expr like "eq.5", "not.is.null", "in.(a,b)", "cs.{a,b}", "fts(simple).word"
  let e = expr, n = neg; while (e.startsWith('not.')) { n = !n; e = e.slice(4); }
  const dot = e.indexOf('.'); const op0 = e.slice(0, dot); const val = e.slice(dot + 1);
  const c = col.includes('->') ? col : q(col); let sql;
  const op = op0.replace(/\(.*\)$/, '');
  if (op === 'is') sql = `${c} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : val === 'false' ? 'false' : 'unknown'}`;
  else if (op === 'in') sql = `${c} in (${splitTop(val.replace(/^\(|\)$/g, '')).map((x) => lit(x.replace(/^"|"$/g, ''))).join(',')})`;
  else if (OPS[op]) sql = `${c} ${OPS[op]} ${lit(op === 'like' || op === 'ilike' ? val.replace(/\*/g, '%') : val)}`;
  else if (op === 'cs') sql = `${c} @> ${lit(val)}`;
  else if (op === 'cd') sql = `${c} <@ ${lit(val)}`;
  else if (op === 'ov') sql = `${c} && ${lit(val)}`;
  else if (['fts', 'plfts', 'phfts', 'wfts'].includes(op)) {
    const cfg = (op0.match(/\((\w+)\)/) || [])[1]; const fn = { fts: 'to_tsquery', plfts: 'plainto_tsquery', phfts: 'phraseto_tsquery', wfts: 'websearch_to_tsquery' }[op];
    sql = `${c} @@ ${fn}(${cfg ? lit(cfg) + ',' : ''}${lit(val)})`;
  } else throw httpErr(400, 'PGRST100', `unsupported operator ${op}`);
  return n ? `not (${sql})` : sql;
}
function logic(kind, body, neg = false) { // body "(a.eq.1,b.is.null,and(c.gt.2,d.lt.3))"
  const parts = splitTop(body.replace(/^\(|\)$/g, '')).map((p) => {
    const m = p.match(/^(not\.)?(and|or)\((.*)\)$/s);
    if (m) return logic(m[2], `(${m[3]})`, !!m[1]);
    const i = p.indexOf('.'); return condition(p.slice(0, i), p.slice(i + 1));
  });
  const sql = `(${parts.join(kind === 'and' ? ' and ' : ' or ')})`; return neg ? `not ${sql}` : sql;
}
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
// qualify: build conditions against a table alias
function whereFor(params, alias, relPrefix = null) {
  const conds = [];
  for (const [k, v] of params) {
    if (RESERVED.has(k)) continue;
    const embedded = k.includes('.') && !k.includes('->');
    if (relPrefix === null ? embedded : !(embedded && k.startsWith(relPrefix + '.'))) continue;
    const col = relPrefix ? k.slice(relPrefix.length + 1) : k;
    if (['or', 'and', 'not.or', 'not.and'].includes(col)) { conds.push(logic(col.replace('not.', ''), v, col.startsWith('not.'))); continue; }
    const c = condition(col, v); conds.push(c.replace(new RegExp(`"${col}"`), `${alias}."${col}"`));
  }
  return conds;
}

export function createShim(rootDb, { base = '/rest/v1', jwtSecret } = {}) {
  if (!jwtSecret) throw new Error('createShim needs jwtSecret');
  let db = rootDb; // swapped to the open transaction while a request runs
  const fkCache = new Map(); const denials = [];
  async function fks() {
    if (fkCache.size) return fkCache;
    const r = await exec(`select c.conrelid::regclass::text as src, c.confrelid::regclass::text as dst, c.conname,
      (select a.attname from pg_attribute a where a.attrelid=c.conrelid and a.attnum=c.conkey[1]) as src_col,
      (select a.attname from pg_attribute a where a.attrelid=c.confrelid and a.attnum=c.confkey[1]) as dst_col
      from pg_constraint c where c.contype='f' and array_length(c.conkey,1)=1`);
    fkCache.set('rows', r.rows.map((x) => ({ ...x, src: x.src.replace(/^public\./, ''), dst: x.dst.replace(/^public\./, '') }))); return fkCache;
  }
  async function relation(parent, rel, hint) {
    const rows = (await fks()).get('rows');
    const m2o = rows.filter((f) => f.src === parent && f.dst === rel && (!hint || f.src_col === hint || f.conname === hint));
    const o2m = rows.filter((f) => f.src === rel && f.dst === parent && (!hint || f.src_col === hint || f.conname === hint));
    if (m2o.length + o2m.length !== 1) throw httpErr(m2o.length + o2m.length ? 300 : 400, 'PGRST200', `no unique relationship ${parent}->${rel}`);
    return m2o.length ? { one: true, parentCol: m2o[0].src_col, childCol: m2o[0].dst_col } : { one: false, parentCol: o2m[0].dst_col, childCol: o2m[0].src_col };
  }
  let aliasN = 0;
  // Build a column list expression for table `table` aliased `a`, with embeds. Returns {cols, innerConds}
  async function projection(table, a, items, params, prefix) {
    const cols = []; const inner = [];
    for (const it of items) {
      if (it.col === '*') cols.push(`${a}.*`);
      else if (it.col) cols.push(`${a}.${q(it.col)}${it.alias !== it.col ? ' as ' + q(it.alias) : ''}`);
      else {
        const r = await relation(table, it.rel, it.hint); const e = `e${++aliasN}`;
        const subPrefix = prefix ? `${prefix}.${it.alias}` : it.alias;
        const sub = await projection(it.rel, e, it.children, params, subPrefix);
        const econds = [`${e}.${q(r.childCol)} = ${a}.${q(r.parentCol)}`, ...whereFor(params, e, subPrefix)];
        const body = `select ${sub.cols.join(', ')} from ${q(it.rel)} ${e} where ${econds.join(' and ')}`;
        cols.push(r.one ? `(select to_json(x) from (${body}) x) as ${q(it.alias)}`
                        : `(select coalesce(json_agg(x), '[]'::json) from (${body}) x) as ${q(it.alias)}`);
        if (it.inner) inner.push(`exists (select 1 from ${q(it.rel)} ${e}f where ${e}f.${q(r.childCol)} = ${a}.${q(r.parentCol)}${whereFor(params, e + 'f', subPrefix).length ? ' and ' + whereFor(params, e + 'f', subPrefix).join(' and ') : ''})`);
        inner.push(...sub.inner);
      }
    }
    return { cols, inner };
  }
  const orderBy = (s, a) => s ? ' order by ' + splitTop(s).map((p) => { const [c, ...m] = p.split('.'); return `${a}.${q(c)}${m.includes('desc') ? ' desc' : ' asc'}${m.includes('nullsfirst') ? ' nulls first' : m.includes('nullslast') ? ' nulls last' : ''}`; }).join(', ') : '';

  async function exec(sql) { const b = bind(sql); return db.query(b.sql, b.params); }
  const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  async function handleInner(req) {
    const url = new URL(req.url); const method = req.method.toUpperCase();
    const prefer = Object.fromEntries((req.headers.get('prefer') || '').split(',').map((s) => s.trim().split('=')).filter((x) => x[0]));
    const accept = req.headers.get('accept') || '';
    const params = [...url.searchParams.entries()];
    const P = url.searchParams;
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length + 1) : null;
    if (path === null) return json(404, { message: 'not a rest path' });
    try {
      // ---------- RPC ----------
      if (path.startsWith('rpc/')) {
        const fn = path.slice(4); let args = {};
        if (method === 'POST') { const t = await req.text(); args = t ? JSON.parse(t) : {}; }
        else args = Object.fromEntries(params);
        const meta = (await exec(`select p.proretset, t.typtype, t.typname from pg_proc p join pg_type t on t.oid=p.prorettype where p.proname=${lit(fn)} and p.pronamespace='public'::regnamespace limit 1`)).rows[0];
        if (!meta) throw httpErr(404, 'PGRST202', `function ${fn} not found`);
        const argSql = Object.entries(args).map(([k, v]) => `${q(k)} => ${v === null ? 'null' : Array.isArray(v) ? lit(`{${v.map((x) => `"${String(x).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`) : typeof v === 'object' ? jlit(v) : lit(v)}`).join(', ');
        const composite = meta.typtype === 'c' || meta.typtype === 'p' || meta.proretset;
        let r;
        if (meta.proretset || meta.typtype === 'c') r = await exec(`select coalesce(json_agg(t), '[]'::json) as d from ${q(fn)}(${argSql}) t`);
        else r = await exec(`select to_json(${q(fn)}(${argSql})) as d`);
        let d = r.rows[0].d;
        if (!meta.proretset && meta.typtype === 'c') d = d[0] ?? null;
        if (meta.typname === 'void') return new Response(null, { status: 204 });
        return json(200, d);
      }
      const table = path; q(table);
      const sel = parseSelect(P.get('select') || '*');
      const a = 't';
      // ---------- READ ----------
      if (method === 'GET' || method === 'HEAD') {
        const proj = await projection(table, a, sel, params, '');
        const conds = [...whereFor(params, a), ...proj.inner]; const W = conds.length ? ' where ' + conds.join(' and ') : '';
        const limit = P.get('limit'), offset = P.get('offset');
        let total = null;
        if (prefer.count === 'exact') total = Number((await exec(`select count(*)::int as n from ${q(table)} ${a}${W}`)).rows[0].n);
        let rows = [];
        if (method === 'GET') {
          const s = `select coalesce(json_agg(r), '[]'::json) as d from (select ${proj.cols.join(', ')} from ${q(table)} ${a}${W}${orderBy(P.get('order'), a)}${limit ? ' limit ' + Number(limit) : ''}${offset ? ' offset ' + Number(offset) : ''}) r`;
          rows = (await exec(s)).rows[0].d;
        }
        const from = Number(offset || 0); const cr = total === null ? undefined : `${rows.length ? `${from}-${from + rows.length - 1}` : '*'}/${total}`;
        const h = cr ? { 'content-range': cr } : {};
        if (method === 'HEAD') return new Response(null, { status: 200, headers: h });
        if (accept.includes('vnd.pgrst.object')) {
          if (rows.length !== 1) return json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null });
          return json(200, rows[0], h);
        }
        return json(200, rows, h);
      }
      // ---------- WRITE ----------
      const body = JSON.parse((await req.text()) || 'null');
      const returning = prefer.return === 'representation';
      const retCols = (await projection(table, 'w', sel, [], '')).cols.join(', ');
      const wrap = (stmt) => `with w0 as (${stmt}) select coalesce(json_agg(r), '[]'::json) as d from (select ${retCols.replace(/\bw\./g, 'w.')} from w0 w) r`;
      let stmt;
      if (method === 'POST') {
        const rowsIn = Array.isArray(body) ? body : [body]; if (!rowsIn.length) return json(201, []);
        const cols = [...new Set(P.get('columns') ? P.get('columns').replace(/"/g, '').split(',') : rowsIn.flatMap(Object.keys))];
        const colSql = cols.map(q).join(', ');
        let ins = `insert into ${q(table)} (${colSql}) select ${colSql} from jsonb_populate_recordset(null::${q(table)}, ${jlit(rowsIn)}::jsonb)`;
        const oc = P.get('on_conflict')?.replace(/"/g, '');
        if (prefer.resolution || oc) {
          const target = oc ? `(${oc.split(',').map(q).join(', ')})` : '';
          ins += prefer.resolution === 'ignore-duplicates' ? ` on conflict ${target} do nothing`
            : ` on conflict ${target} do update set ${cols.filter((c) => !(oc || '').split(',').includes(c)).map((c) => `${q(c)} = excluded.${q(c)}`).join(', ') || `${q(cols[0])} = excluded.${q(cols[0])}`}`;
        }
        stmt = ins + ' returning *';
      } else if (method === 'PATCH') {
        const cols = Object.keys(body); const conds = whereFor(params, q(table));
        stmt = `update ${q(table)} set ${cols.map((c) => `${q(c)} = (jsonb_populate_record(null::${q(table)}, ${jlit({ [c]: body[c] })}::jsonb)).${q(c)}`).join(', ')}${conds.length ? ' where ' + conds.join(' and ') : ''} returning *`;
      } else if (method === 'DELETE') {
        const conds = whereFor(params, q(table));
        stmt = `delete from ${q(table)}${conds.length ? ' where ' + conds.join(' and ') : ''} returning *`;
      } else return json(405, { message: 'method not allowed' });
      const r = await exec(wrap(stmt));
      const status = method === 'POST' ? 201 : returning ? 200 : 204;
      if (!returning) return new Response(null, { status: method === 'POST' ? 201 : 204 });
      const d = r.rows[0].d;
      if (accept.includes('vnd.pgrst.object')) return d.length === 1 ? json(status, d[0]) : json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null });
      return json(status, d);
    } catch (e) {
      const sqlstate = e.code && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
      if (sqlstate === '42501') denials.push(`${method} ${path}: ${e.message}`);
      const status = e.status ?? (sqlstate === '23505' ? 409 : sqlstate === '42501' ? 403 : sqlstate === '42P01' ? 404 : 400);
      return json(status, { code: sqlstate || e.code || 'PGRST000', message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
    }
  }
  // Verify the JWT, then run the whole request in one transaction as the token's role with its claims set.
  const ROLLBACK = Symbol('rollback');
  async function handle(req) {
    const hdr = req.headers.get('authorization'); const token = hdr && /^bearer /i.test(hdr) ? hdr.slice(7).trim() : req.headers.get('apikey');
    let claims;
    try { claims = verifyJwt(token, jwtSecret); } catch (e) { return json(e.status ?? 401, { code: e.code ?? 'PGRST301', message: e.message }); }
    if (!ROLES.has(claims.role)) return json(401, { code: 'PGRST301', message: `role claim ${claims.role} not allowed` });
    let resp;
    try {
      await rootDb.transaction(async (tx) => {
        db = tx; BIND = new Map(); BIND_N = 0;
        try {
          await tx.query(`set local role "${claims.role}"`);
          await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
          resp = await handleInner(req);
        } finally { db = rootDb; }
        if (resp.status >= 400) throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return resp;
  }
  // fetch-compatible
  const shim = async (input, init) => handle(input instanceof Request ? input : new Request(input, init));
  shim.denials = denials; // permission-denied (42501) errors seen, including ones the app swallows
  return shim;
}
