// Boots PGlite + migrations + seed, and routes supabase-js through the shim by patching globalThis.fetch.
// App code is untouched: it calls getServiceClient() -> createClient(NEXT_PUBLIC_SUPABASE_URL, key).
import { open, migrate } from '../db.mjs';
import { createShim, signJwt } from '../shim.mjs';
export const SECRET = 'spike-test-secret-0123456789-abcdefghij';
export const USER_B = '00000000-0000-0000-0000-00000000000b';
export const keys = {
  anon: signJwt({ role: 'anon', iss: 'spike' }, SECRET),
  service: signJwt({ role: 'service_role', iss: 'spike' }, SECRET),
  user: (sub) => signJwt({ role: 'authenticated', aud: 'authenticated', sub, iss: 'spike' }, SECRET),
};
export const USER = '00000000-0000-0000-0000-000000000001';
export const ids = { project: '11111111-1111-1111-1111-111111111111', s1: '21111111-1111-1111-1111-111111111111', s2: '22222222-2222-2222-2222-222222222222', s3: '23333333-3333-3333-3333-333333333333', m1: '31111111-1111-1111-1111-111111111111', m2: '32222222-2222-2222-2222-222222222222' };
export async function boot() {
  const db = await open(); const mig = await migrate(db, { log: false });
  if (mig.fails.length) throw new Error('migrations failed: ' + JSON.stringify(mig.fails));
  const shim = createShim(db, { jwtSecret: SECRET });
  const real = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://pglite.local'; 
  // SPIKE_ROLE=authenticated makes every getServiceClient() in the app run as user A's JWT (not what prod does; see findings).
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SPIKE_ROLE === 'authenticated' ? keys.user(USER) : keys.service;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = keys.anon;
  for (const k of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_BASE_URL']) delete process.env[k];
  let calls = 0;
  globalThis.fetch = async (input, init) => { const u = typeof input === 'string' ? input : input.url ?? String(input); if (u.startsWith('http://pglite.local/rest/v1')) { calls++; return shim(input, init); } throw new Error('unexpected network call: ' + u); };
  await seed(db);
  return { db, shim, stats: () => calls, restore: () => { globalThis.fetch = real; } };
}
async function seed(db) {
  await db.exec(`
  insert into auth.users(id,email) values ('${USER_B}','b@membral.local') on conflict do nothing;
  insert into profiles(id,email,tier,conversation_limit) values ('${USER_B}','b@membral.local','free',50) on conflict (id) do nothing;
  insert into code_projects(id,user_id,repo_identity,display_name) values ('4bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','${USER_B}','codehub/b-private','B Private');
  insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash,started_at,title) values
   ('4bbbbbbb-0000-bbbb-bbbb-bbbbbbbbbbbb','${USER_B}','4bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','claude-code','sess-b1','hb1', now(),'B secret work');
  insert into session_memories(id,user_id,code_session_id,code_project_id,source,kind,text,quote,turn_idx,turn_role,content_hash,session_title) values
   ('4bbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb','${USER_B}','4bbbbbbb-0000-bbbb-bbbb-bbbbbbbbbbbb','4bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','extractor','decision','B private decision','q',1,'user','cb1','B secret work');
  insert into profiles(id,email,tier,conversation_limit) values ('${USER}','local@membral.local','free',50) on conflict (id) do nothing;
  insert into code_projects(id,user_id,repo_identity,display_name) values ('${ids.project}','${USER}','codehub/acme-api','Acme API');
  insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash,git_branch,started_at,title) values
   ('${ids.s1}','${USER}','${ids.project}','claude-code','sess-1','h1','feat/retry', now() - interval '1 day','Fix import 504'),
   ('${ids.s2}','${USER}','${ids.project}','claude-code','sess-2','h2','main', now() - interval '2 days','Queue env accessors'),
   ('${ids.s3}','${USER}','${ids.project}','claude-code','sess-3','h3','main', now() - interval '40 days','Old work');
  insert into session_memories(id,user_id,code_session_id,code_project_id,source,kind,text,quote,turn_idx,turn_role,content_hash,session_title) values
   ('${ids.m1}','${USER}','${ids.s1}','${ids.project}','extractor','decision','Retry the import on a 504 with exponential backoff','retry on 504 with backoff',3,'assistant','c1','Fix import 504'),
   ('${ids.m2}','${USER}','${ids.s2}','${ids.project}','extractor','learning','The queue env accessors live in queue.ts and must not be converted','leave queue.ts alone',5,'user','c2','Queue env accessors');
  insert into served_record_verdicts(user_id,code_session_id,memory_id,surface,verdict,quote,turn_idx,prompt_version) values
   ('${USER}','${ids.s1}','${ids.m1}','mcp','contradicted','actually no backoff needed',9,'v1'),
   ('${USER}','${ids.s1}','${ids.m2}','mcp','confirmed','yes queue.ts',10,'v1');
  insert into conversations(user_id,source,source_id,title,created_at) values
   ('${USER}','chatgpt','c-1','Trip planning', now() - interval '3 days'),
   ('${USER}','chatgpt','c-2','Recipe ideas', now() - interval '2 days'),
   ('${USER}','claude-code','c-3','Mirrored code session', now() - interval '1 days');
  insert into extracted_metadata(conversation_id,summary,topics,conversation_type) select id,'s',array['travel','food'],'planning' from conversations where source='chatgpt';
  insert into llm_spend(user_id,pass,model,cost_usd,spent_at) values ('${USER}','extract','m',0.25, now()),('${USER}','extract','m',0.5, now() - interval '1 day');
  `);
}
