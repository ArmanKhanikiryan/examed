/// <reference types="node" />
// Attacker review (docs/SECURITY-REVIEW.md): a free account + the publishable key + the shipped
// client trying to get paid questions, answers or explanations. Runs against the local stack.
// Open holes, if any, are `todo` tests (they run and print, but do not fail `npm test`); flip them to plain
// tests when the owner's fix lands.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const status = JSON.parse(execSync('npx supabase status -o json').toString().replace(/^[^{]*/, ''));
const URL: string = status.API_URL;
const KEY: string = status.PUBLISHABLE_KEY;
const WEBHOOK = `${URL}/functions/v1/revenuecat-webhook`;
const SECRET = /REVENUECAT_WEBHOOK_AUTH=(\S+)/.exec(readFileSync('supabase/.env', 'utf8'))![1];
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

// Test data hygiene for the shared dev database: each run deletes the users it made and sweeps
// leftovers of crashed runs (own email domain, older than 15 min, so a parallel run is untouched).
async function deleteUsers(admin: SupabaseClient, ids: string[]) {
  for (const id of ids) await admin.auth.admin.deleteUser(id);
}

async function sweepUsers(admin: SupabaseClient, domain: string) {
  const stale = Date.now() - 15 * 60e3;
  for (let page = 1; ; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    const users = data?.users ?? [];
    await deleteUsers(admin, users.filter((u) => u.email?.endsWith(`@${domain}`) && Date.parse(u.created_at) < stale).map((u) => u.id));
    if (users.length < 1000) return;
  }
}

const admin = createClient(URL, status.SERVICE_ROLE_KEY, opts);
const anon = createClient(URL, KEY, opts);
const sql = (q: string) =>
  execSync('docker exec -i supabase_db_medprep psql -U postgres -At -F "|" -v ON_ERROR_STOP=1', { input: q }).toString().trim();
const rows = (q: string) => sql(q).split('\n').filter(Boolean);

const TAG = `sec${Date.now()}`;
const FREE = `${TAG}-free`;
const PAID = `${TAG}-paid`;
const OTHER = `${TAG}-other`;
const KINDS = `${TAG}-kinds`; // paid, one compound question
const KQ: { id: string; right: string; wrong: string } = { id: '', right: '', wrong: '' };
const DEVICE = 'device-sec-1';
const PASS = 'sec-pass-12345';

type Q = { id: string; right: string; wrong: string };
const fixture: Record<string, Q[]> = {};
type User = { c: SupabaseClient; id: string; email: string };
let free: User, payer: User, buyer: User;
const created: string[] = [];

async function signIn(email: string) {
  const c = createClient(URL, KEY, opts);
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASS });
  assert.ifError(error);
  return { c, id: data.user!.id, email };
}
async function user(name: string, device: string | null = DEVICE): Promise<User> {
  const email = `${name}-${TAG}@sec.test`;
  assert.ifError((await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true })).error);
  const u = await signIn(email);
  created.push(u.id);
  if (device) assert.ifError((await u.c.rpc('register_device', { p_device_id: device })).error);
  return u;
}
function webhook(auth: string | null, body: unknown, method = 'POST') {
  return fetch(WEBHOOK, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth === null ? {} : { Authorization: auth }) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}
const event = (e: Record<string, unknown>) => ({ api_version: '1.0', event: { id: crypto.randomUUID(), ...e } });
const grant = (id: string, ent: string, extra: Record<string, unknown> = {}) =>
  webhook(SECRET, event({ type: 'INITIAL_PURCHASE', app_user_id: id, entitlement_ids: [ent], expiration_at_ms: Date.now() + 86400e3, ...extra }));
const ents = async (id: string) => (await admin.from('entitlements').select('*').eq('user_id', id)).data!;

before(async () => {
  // leftovers of crashed runs (fixture ids carry their start time)
  sql(`delete from public.tests where id ~ '^sec[0-9]{13}-' and substring(id from 4 for 13)::bigint < ${Date.now() - 15 * 60e3}`);
  sql(`delete from public.tests where id ~ '^guard-[0-9]{13}$' and substring(id from 7 for 13)::bigint < ${Date.now() - 15 * 60e3}`);
  await sweepUsers(admin, 'sec.test');
  assert.ifError((await admin.from('tests').insert([
    { id: FREE, subject_id: 'physiology', title: { en: 'sec free' }, position: 90, is_free: true },
    { id: PAID, subject_id: 'physiology', title: { en: 'sec paid' }, position: 91, is_free: false },
    { id: OTHER, subject_id: 'physiology', title: { en: 'sec other' }, position: 92, is_free: false },
    { id: KINDS, subject_id: 'physiology', title: { en: 'sec kinds' }, position: 93, is_free: false },
  ])).error);
  const { data: kq, error: kqe } = await admin.from('questions').insert({ test_id: KINDS, kind: 'compound', position: 0,
    body: `${KINDS} secret stem`, explanation: `${KINDS} secret why`,
    statements: [1, 2, 3, 4].map((n) => ({ n, text: `${KINDS} secret statement ${n}` })) }).select('id').single();
  assert.ifError(kqe);
  KQ.id = kq!.id;
  const { data: kc } = await admin.from('choices').insert([
    { question_id: KQ.id, body: '1, 2', combo: [1, 2], is_correct: false, position: 0 },
    { question_id: KQ.id, body: '1, 3, 4', combo: [1, 3, 4], is_correct: true, position: 1 },
    { question_id: KQ.id, body: 'only 4', combo: [4], is_correct: false, position: 2 },
  ]).select('id, is_correct');
  KQ.right = kc!.find((c) => c.is_correct)!.id;
  KQ.wrong = kc!.find((c) => !c.is_correct)!.id;
  for (const t of [FREE, PAID, OTHER]) {
    const { data: qs, error } = await admin.from('questions')
      .insert([0, 1, 2].map((i) => ({ test_id: t, body: `${t} secret body ${i}`, explanation: `${t} secret why ${i}`, position: i })))
      .select('id');
    assert.ifError(error);
    fixture[t] = [];
    for (const q of qs!) {
      const { data: cs } = await admin.from('choices')
        .insert([{ question_id: q.id, body: 'right', is_correct: true, position: 0 }, { question_id: q.id, body: 'wrong', is_correct: false, position: 1 }])
        .select('id, is_correct');
      fixture[t].push({ id: q.id, right: cs!.find((c) => c.is_correct)!.id, wrong: cs!.find((c) => !c.is_correct)!.id });
    }
  }
  [free, payer, buyer] = await Promise.all([user('free'), user('payer'), user('buyer')]);
  assert.equal((await grant(payer.id, 'all')).status, 200);
  assert.equal((await grant(buyer.id, `test:${PAID}`, { type: 'NON_RENEWING_PURCHASE', expiration_at_ms: null })).status, 200);
});

after(async () => {
  await admin.from('tests').delete().in('id', [FREE, PAID, OTHER, KINDS]);
  await deleteUsers(admin, created);
});

// ------------------------------------------------------------ 1. database surface (catalog)

const CLIENT_ROLES = `('anon','authenticated')`;
// Every function a client may call. Add engagement RPCs here as they land, after review.
const ANON_RPCS = ['get_test_questions', 'list_tests', 'list_subjects',
  // full mock exam (20261122300000_full_exam.sql), reviewed: counts and config only
  'full_exam_info'];
const AUTH_RPCS = [...ANON_RPCS, 'finish_attempt', 'get_review_questions', 'register_device', 'start_attempt', 'submit_answer',
  // engagement layer (20261121100000_engagement.sql), reviewed
  'get_activity', 'get_engagement', 'list_flagged', 'save_push_token', 'set_daily_goal', 'set_timezone', 'subject_stats',
  // round three (20261121120000_exam_review_devices_caps.sql), reviewed
  'get_review_list', 'remove_device', 'review_due_count',
  // full mock exam (20261122300000_full_exam.sql), reviewed
  'start_full_exam', 'get_full_exam_questions',
  // pricing (20261124000000_subject_year_entitlements.sql), reviewed: counts, prices, own entitlements
  'paywall_info'];
const sorted = (a: string[]) => [...a].sort();

test('catalog: every public table has RLS', () => {
  assert.deepEqual(rows(`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`), []);
});

test('catalog: questions and choices have no client grants and are not published to realtime', () => {
  assert.deepEqual(rows(`select table_name || ' ' || grantee || ' ' || privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('questions','choices') and grantee in ${CLIENT_ROLES}`), []);
  assert.deepEqual(rows(`select table_name || ' ' || grantee from information_schema.column_privileges
    where table_schema = 'public' and table_name in ('questions','choices') and grantee in ${CLIENT_ROLES}`), []);
  assert.deepEqual(rows(`select tablename from pg_publication_tables where schemaname = 'public'
    and tablename in ('questions','choices','entitlements','answers')`), []);
});

test('catalog: clients write only through the reviewed column grants', () => {
  const writes = rows(`select table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type
    from information_schema.column_privileges where table_schema = 'public' and grantee in ${CLIENT_ROLES}
    and privilege_type in ('INSERT','UPDATE')`);
  assert.deepEqual(sorted(writes), sorted([
    'profiles.locale authenticated UPDATE',
    'profiles.exam_date authenticated UPDATE',
    'profiles.faculty_id authenticated UPDATE',
    'profiles.year authenticated UPDATE',
    'question_flags.question_id authenticated INSERT',
    'question_reports.message authenticated INSERT',
    'question_reports.question_id authenticated INSERT',
    'question_reports.reason authenticated INSERT',
  ]));
  const tableWrites = rows(`select table_name || ' ' || grantee || ' ' || privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ${CLIENT_ROLES} and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`);
  assert.deepEqual(sorted(tableWrites), ['question_flags authenticated DELETE']);
});

test('catalog: only reviewed RPCs are callable by clients, all security definer ones pin search_path', () => {
  const callable = (role: string) => rows(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('${role}', p.oid, 'execute')`);
  assert.deepEqual(sorted(callable('anon')), sorted(ANON_RPCS));
  assert.deepEqual(sorted(callable('authenticated')), sorted(AUTH_RPCS));
  assert.deepEqual(rows(`select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.prosecdef
    and not coalesce(p.proconfig @> array['search_path=""'], false)`), []);
});

test('catalog: public views run as the caller', () => {
  assert.deepEqual(rows(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v','m')
    and not coalesce(c.reloptions @> array['security_invoker=true'], false)`), []);
});

test('catalog: tables and functions created later are not exposed to clients by default', () => {
  // schema-level defaults must not add anon/authenticated...
  assert.deepEqual(rows(`select defaclobjtype::text || ' ' || array_to_string(defaclacl, ',') from pg_default_acl
    where defaclnamespace = 'public'::regnamespace and defaclrole = 'postgres'::regrole
    and array_to_string(defaclacl, ',') ~ '(^|,)(anon|authenticated)='`), []);
  // ...and EXECUTE for PUBLIC on new functions can only be removed globally (no IN SCHEMA)
  assert.deepEqual(rows(`select array_to_string(defaclacl, ',') from pg_default_acl
    where defaclnamespace = 0 and defaclrole = 'postgres'::regrole and defaclobjtype = 'f'
    and not array_to_string(defaclacl, ',') ~ '(^|,)='`).length, 1);
});

test('storage: no buckets, and clients cannot create one', async () => {
  assert.deepEqual(rows(`select id from storage.buckets`), []);
  for (const c of [anon, free.c]) {
    const { error } = await c.storage.createBucket(`${TAG}-leak`, { public: true });
    assert.ok(error, 'bucket create must fail');
  }
  assert.deepEqual(rows(`select id from storage.buckets`), []);
});

// ------------------------------------------------------------ 1b. PostgREST / GraphQL as attacker

test('direct reads, embeds and filters return no paid content', async () => {
  for (const c of [anon, free.c, payer.c]) {
    assert.equal((await c.from('questions').select('*').eq('test_id', PAID)).data?.length ?? 0, 0);
    assert.equal((await c.from('choices').select('*').limit(5)).data?.length ?? 0, 0);
    const embed = await c.from('tests').select('id, questions(body, explanation, choices(body, is_correct))').eq('id', PAID);
    assert.ok(embed.error || !JSON.stringify(embed.data).includes('secret'), JSON.stringify(embed.data));
  }
  // a user reads only their own rows, whatever filter they send
  for (const t of ['entitlements', 'devices', 'answers', 'attempts', 'review_items', 'daily_activity', 'profiles', 'question_reports']) {
    const { data } = await free.c.from(t).select('*');
    assert.ok((data ?? []).every((r: Record<string, unknown>) => (r.user_id ?? r.id) === free.id), t);
    assert.equal((await free.c.from(t).select('*').eq(t === 'profiles' ? 'id' : 'user_id', payer.id)).data?.length ?? 0, 0, t);
    assert.equal((await anon.from(t).select('*')).data?.length ?? 0, 0, t);
  }
  // deleting someone else's device is a no-op
  await free.c.from('devices').delete().eq('user_id', payer.id);
  assert.equal((await admin.from('devices').select('*').eq('user_id', payer.id)).data!.length, 1);
});

test('GraphQL and the OpenAPI root expose no questions or choices', async () => {
  const spec = await (await fetch(`${URL}/rest/v1/`, { headers: { apikey: KEY } })).json();
  assert.ok(!Object.keys(spec.paths).some((p) => /\/(questions|choices)$|apply_revenuecat/.test(p)), Object.keys(spec.paths).join());
  for (const token of [KEY, (await free.c.auth.getSession()).data.session!.access_token]) {
    const res = await fetch(`${URL}/graphql/v1`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { queryType { fields { name } } } }' }),
    });
    // pg_graphql is not enabled locally; if it is turned on, questions/choices must stay out
    const fields: string[] = ((await res.json()).data?.__schema.queryType.fields ?? []).map((f: { name: string }) => f.name);
    assert.ok(!fields.some((f) => /^(questions|choices)Collection$/.test(f)), fields.join());
    const q = await fetch(`${URL}/graphql/v1`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ questionsCollection { edges { node { body } } } }' }),
    });
    assert.ok(!(await q.text()).includes('secret'));
  }
});

test('get_test_questions: argument tricks do not widen access', async () => {
  const call = (c: SupabaseClient, args: Record<string, unknown>) => c.rpc('get_test_questions', { p_device_id: DEVICE, ...args });
  for (const args of [
    { p_test_id: PAID },
    { p_test_id: PAID, p_lang: "en' or '1'='1" },
    { p_test_id: `${PAID}' or '1'='1` },
    { p_test_id: null },
  ]) {
    const r = await call(free.c, args);
    assert.ok(r.error, JSON.stringify(args));
    assert.ok(!JSON.stringify(r).includes('secret'));
  }
  // the buyer of one test cannot reach another paid test
  assert.equal((await call(buyer.c, { p_test_id: OTHER })).error?.message, 'no_access');
  const ok = await call(payer.c, { p_test_id: PAID, p_offset: -100, p_limit: 1_000_000 });
  assert.equal(ok.data.length, 3);
  assert.equal((await call(payer.c, { p_test_id: PAID, p_offset: 2_147_483_647 })).data.length, 0);
});

// ------------------------------------------------------------ 2. side channels

test('submit_answer is not an oracle on locked tests', async () => {
  const q = fixture[PAID][0];
  const r1 = await free.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: q.right });
  const r2 = await free.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: q.wrong });
  assert.equal(r1.error?.message, 'no_access');
  assert.equal(r2.error?.message, 'no_access');
  assert.equal(r1.data, r2.data);
  // anon cannot call it at all
  assert.ok((await anon.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: q.right })).error);
  // replaying someone else's answer id returns no grade
  const theirs = crypto.randomUUID();
  assert.equal((await payer.c.rpc('submit_answer', { p_id: theirs, p_question_id: q.id, p_choice_id: q.right })).data, true);
  const stolen = await free.c.rpc('submit_answer', { p_id: theirs, p_question_id: q.id, p_choice_id: q.wrong });
  assert.ok(stolen.error);
  assert.ok(!/true|right/.test(stolen.error.message + (stolen.error.details ?? '')));
});

test('attempts, review, reports and list_tests leak nothing on locked tests', async () => {
  assert.equal((await free.c.rpc('start_attempt', { p_test_id: PAID, p_mode: 'exam' })).error?.message, 'no_access');
  const { data: theirAttempt } = await payer.c.rpc('start_attempt', { p_test_id: PAID, p_mode: 'exam' });
  assert.equal((await free.c.rpc('finish_attempt', { p_attempt_id: theirAttempt })).error?.message, 'bad_attempt');
  // report insert: same refusal for a locked question and a made-up one
  const locked = await free.c.from('question_reports').insert({ question_id: fixture[PAID][0].id, message: 'x' });
  const fake = await free.c.from('question_reports').insert({ question_id: crypto.randomUUID(), message: 'x' });
  assert.ok(locked.error && fake.error);
  assert.equal(locked.error.message, fake.error.message, 'locked and missing questions look the same');
  assert.ok(!(await free.c.from('question_reports').insert({ question_id: fixture[FREE][0].id, message: 'typo' })).error);
  const review = await free.c.rpc('get_review_questions', { p_device_id: DEVICE });
  assert.ok(!JSON.stringify(review).includes(`${PAID} secret`));
  const { data: list } = await free.c.rpc('list_tests', { p_subject_id: 'physiology' });
  assert.ok(!JSON.stringify(list).includes('secret'));
  assert.equal(list.find((t: { id: string }) => t.id === PAID).unlocked, false);
});

test('a lapsed user keeps only their own answer history, not new content', async () => {
  const u = await user('lapsed');
  assert.equal((await grant(u.id, 'all')).status, 200);
  const q = fixture[OTHER][0];
  assert.equal((await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: q.wrong })).data, false);
  const res = await webhook(SECRET, event({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: u.id, entitlement_ids: ['all'] }));
  assert.equal(await res.text(), '{"result":"revoked"}');
  assert.equal((await u.c.rpc('get_test_questions', { p_test_id: OTHER, p_device_id: DEVICE })).error?.message, 'no_access');
  assert.equal((await u.c.rpc('get_review_questions', { p_device_id: DEVICE })).data.length, 0);
  const embed = await u.c.from('answers').select('question_id, choices(body, is_correct), questions(body)');
  assert.ok(embed.error || !JSON.stringify(embed.data).includes('secret'));
  assert.equal((await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: q.right })).error?.message, 'no_access');
});

test('exam: the last answer before submit counts, nothing after submit or the time limit', async () => {
  const u = await user('examiner');
  assert.equal((await grant(u.id, 'all')).status, 200);
  const [q0, q1, q2] = fixture[PAID];
  const answer = (attempt: string, q: Q, choice: string, extra: Record<string, unknown> = {}) =>
    u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: choice, p_attempt_id: attempt, ...extra });
  const { data: a } = await u.c.rpc('start_attempt', { p_test_id: PAID, p_mode: 'exam' });
  await answer(a, q0, q0.wrong);
  await answer(a, q0, q0.right); // changed answer: counts
  await answer(a, q1, q1.right);
  // L3 stays closed: a later answer dated an hour back is still the later one
  await answer(a, q1, q1.wrong, { p_answered_at: new Date(Date.now() - 3600e3).toISOString() });
  const replayId = crypto.randomUUID();
  await u.c.rpc('submit_answer', { p_id: replayId, p_question_id: q2.id, p_choice_id: q2.wrong, p_attempt_id: a });
  // another user cannot answer into or submit this attempt
  assert.equal((await payer.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q2.id, p_choice_id: q2.right, p_attempt_id: a })).error?.message, 'bad_attempt');
  assert.equal((await payer.c.rpc('finish_attempt', { p_attempt_id: a })).error?.message, 'bad_attempt');
  const first = (await u.c.rpc('finish_attempt', { p_attempt_id: a })).data;
  assert.deepEqual([first.correct, first.total], [1, 3]);
  // after submit: no new answers, a replayed queue item changes nothing, a second submit returns the same
  assert.equal((await answer(a, q2, q2.right)).error?.message, 'attempt_closed');
  assert.equal((await u.c.rpc('submit_answer', { p_id: replayId, p_question_id: q2.id, p_choice_id: q2.wrong, p_attempt_id: a })).data, false);
  assert.deepEqual((await u.c.rpc('finish_attempt', { p_attempt_id: a })).data, first);
  // the timer is the server's: past the deadline (+2 min grace) answers are refused
  const { data: late } = await u.c.rpc('start_attempt', { p_test_id: PAID, p_mode: 'exam' });
  sql(`update public.attempts set deadline = now() - interval '3 minutes' where id = '${late}'`);
  assert.equal((await answer(late, q0, q0.right)).error?.message, 'time_up');
  assert.equal((await u.c.rpc('finish_attempt', { p_attempt_id: late })).data.correct, 0);
  // practice keeps the first answer received, whatever the client-sent time
  const { data: p } = await u.c.rpc('start_attempt', { p_test_id: PAID, p_mode: 'practice' });
  await answer(p, q0, q0.wrong);
  await answer(p, q0, q0.right, { p_answered_at: new Date(Date.now() - 3600e3).toISOString() });
  assert.equal((await u.c.rpc('finish_attempt', { p_attempt_id: p })).data.correct, 0);
});

test('review list: own accessible mistakes only, device checked, gone after access lapses', async () => {
  assert.ok((await anon.rpc('get_review_list')).error);
  assert.ok((await anon.rpc('review_due_count')).error);
  const u = await user('reviewer');
  assert.equal((await grant(u.id, `test:${PAID}`)).status, 200);
  for (const t of [FREE, PAID]) {
    const q = fixture[t][2];
    assert.equal((await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: q.wrong })).data, false);
  }
  const list = (await u.c.rpc('get_review_list', { p_device_id: DEVICE })).data;
  assert.equal(list.length, 2);
  assert.ok(list.every((i: { correctAnswer: string; yourAnswer: string }) => i.correctAnswer === 'right' && i.yourAnswer === 'wrong'));
  assert.equal((await u.c.rpc('review_due_count')).data, 2);
  assert.equal((await u.c.rpc('get_review_list', { p_device_id: 'not-mine-device' })).error?.message, 'device_not_registered');
  // nobody else's mistakes show up
  assert.ok(!JSON.stringify((await free.c.rpc('get_review_list', { p_device_id: DEVICE })).data).includes(`${PAID} secret`));
  await webhook(SECRET, event({ type: 'EXPIRATION', app_user_id: u.id, entitlement_ids: [`test:${PAID}`] }));
  const after = (await u.c.rpc('get_review_list', { p_device_id: DEVICE })).data;
  assert.deepEqual(after.map((i: { testId: string }) => i.testId), [FREE]);
  assert.equal((await u.c.rpc('review_due_count')).data, 1);
});

test('engagement RPCs: anon refused; flags, stats and activity carry no locked content', async () => {
  for (const [fn, args] of [['get_engagement', {}], ['subject_stats', { p_subject_id: 'physiology' }], ['get_activity', { p_days: 7 }],
    ['list_flagged', {}], ['set_daily_goal', { p_goal: 10 }], ['set_timezone', { p_timezone: 'UTC' }],
    ['save_push_token', { p_token: 'x', p_platform: 'ios' }]] as const) {
    assert.ok((await anon.rpc(fn, args)).error, `anon ${fn}`);
  }
  const lockedFlag = await free.c.from('question_flags').insert({ question_id: fixture[PAID][1].id });
  const fakeFlag = await free.c.from('question_flags').insert({ question_id: crypto.randomUUID() });
  assert.ok(lockedFlag.error && fakeFlag.error);
  assert.equal(lockedFlag.error.message, fakeFlag.error.message);
  assert.ok(!(await free.c.from('question_flags').insert({ question_id: fixture[FREE][1].id })).error);
  // a lapsed flag (flagged while paid) stops showing its text
  const u = await user('flagger');
  assert.equal((await grant(u.id, `test:${OTHER}`)).status, 200);
  assert.ifError((await u.c.from('question_flags').insert({ question_id: fixture[OTHER][1].id })).error);
  assert.equal((await u.c.rpc('list_flagged', { p_device_id: DEVICE })).data.length, 1);
  await webhook(SECRET, event({ type: 'EXPIRATION', app_user_id: u.id, entitlement_ids: [`test:${OTHER}`] }));
  assert.equal(JSON.stringify((await u.c.rpc('list_flagged', { p_device_id: DEVICE })).data), '[]');
  for (const [fn, args] of [['get_engagement', {}], ['subject_stats', { p_subject_id: 'physiology' }], ['get_activity', { p_days: 400 }],
    ['list_flagged', { p_device_id: DEVICE }]] as const) {
    const r = await free.c.rpc(fn, args);
    assert.ifError(r.error);
    assert.ok(!JSON.stringify(r.data).includes(`${PAID} secret`), fn);
  }
  // free flag list returns the free stem only
  assert.ok(JSON.stringify((await free.c.rpc('list_flagged', { p_device_id: DEVICE })).data).includes(`${FREE} secret body 1`));
  assert.ok((await free.c.rpc('get_activity', { p_days: 1e9 })).data.length <= 400);
});

test('XP and goal cannot be forged by replays, new ids or empty attempts', async () => {
  const u = await user('xp');
  const xp = async () => (await u.c.rpc('get_engagement')).data as { xp: number; todayCount: number };
  const [q0, q1, q2] = fixture[FREE];
  const id = crypto.randomUUID();
  for (let i = 0; i < 3; i++) await u.c.rpc('submit_answer', { p_id: id, p_question_id: q0.id, p_choice_id: q0.right });
  for (let i = 0; i < 3; i++) await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q0.id, p_choice_id: q0.right });
  assert.deepEqual(await xp(), { ...(await xp()), xp: 1, todayCount: 1 }, 'one question = 1 XP and 1 toward the goal per day');
  // an attempt with no answers, or in a language with no questions, earns nothing
  for (const lang of ['en', 'ru']) {
    const { data: a } = await u.c.rpc('start_attempt', { p_test_id: FREE, p_mode: 'practice', p_lang: lang });
    assert.equal((await u.c.rpc('finish_attempt', { p_attempt_id: a })).data.gain.xp, 0, lang);
  }
  // completing the test pays the +10 bonus once a day, however often it is finished or repeated
  const gains = [];
  for (let n = 0; n < 2; n++) {
    const { data: a } = await u.c.rpc('start_attempt', { p_test_id: FREE, p_mode: 'practice' });
    for (const q of [q0, q1, q2]) await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: q.right, p_attempt_id: a });
    gains.push((await u.c.rpc('finish_attempt', { p_attempt_id: a })).data.gain.xp);
    assert.equal((await u.c.rpc('finish_attempt', { p_attempt_id: a })).data.gain.xp, gains[n], 'replayed finish');
  }
  assert.deepEqual(gains, [12, 0]);
  assert.equal((await xp()).xp, 13);
});

// ------------------------------------------------------------ 3. entitlements and webhook

test('webhook: near-miss secrets, wrong method and replays are refused', async () => {
  const body = event({ type: 'INITIAL_PURCHASE', app_user_id: free.id, entitlement_ids: ['all'], expiration_at_ms: Date.now() + 86400e3 });
  const sameLength = SECRET.slice(0, -1) + (SECRET.endsWith('0') ? '1' : '0');
  // (leading/trailing spaces are stripped by HTTP itself, so ` secret` equals the secret)
  for (const auth of [sameLength, `Bearer ${SECRET}`, `${SECRET}x`, SECRET.toUpperCase() === SECRET ? 'x' : SECRET.toUpperCase(), '', KEY, status.SERVICE_ROLE_KEY]) {
    assert.equal((await webhook(auth, body)).status, 401, `auth ${auth.slice(0, 8)}`);
  }
  assert.equal((await webhook(SECRET, null, 'GET')).status, 405);
  assert.equal((await webhook(SECRET, { event: { type: 'INITIAL_PURCHASE' } })).status, 400);
  assert.equal((await ents(free.id)).length, 0);

  // replay of a captured event id is a no-op, even with a changed body
  const u = await user('replay', null);
  const ev = event({ type: 'INITIAL_PURCHASE', app_user_id: u.id, entitlement_ids: ['all'], expiration_at_ms: Date.now() + 60e3 });
  assert.equal((await webhook(SECRET, ev)).status, 200);
  const replay = await webhook(SECRET, { ...ev, event: { ...ev.event, expiration_at_ms: Date.now() + 365 * 86400e3 } });
  assert.equal(await replay.text(), '{"result":"duplicate"}');
  assert.ok(new Date((await ents(u.id))[0].expires_at).getTime() < Date.now() + 120e3);
  // the comparison takes the same path for every same-length wrong secret
  const src = readFileSync('supabase/functions/revenuecat-webhook/index.ts', 'utf8');
  assert.match(src, /diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/);
});

test('webhook: entitlement ids outside all/test:<id> are dropped; unknown users ignored', async () => {
  const u = await user('weird', null);
  const res = await webhook(SECRET, event({ type: 'INITIAL_PURCHASE', app_user_id: u.id,
    entitlement_ids: ['ALL', 'test%', 'premium', "all' or 1=1"], expiration_at_ms: Date.now() + 86400e3 }));
  assert.equal(res.status, 200);
  assert.equal((await ents(u.id)).length, 0);
  assert.equal(await (await grant(crypto.randomUUID(), 'all')).text(), '{"result":"ignored: unknown user"}');
});

test('webhook: a subscription event without an expiry, or with a bad one, grants nothing and is not retried', async () => {
  const u = await user('noexpiry', null);
  for (const expiration_at_ms of [undefined, null, 'abc', '1e999']) {
    assert.equal((await grant(u.id, 'all', { expiration_at_ms })).status, 400, String(expiration_at_ms));
  }
  assert.equal((await ents(u.id)).length, 0);
  // a single-test purchase may still be lifetime
  assert.equal((await grant(u.id, `test:${PAID}`, { type: 'NON_RENEWING_PURCHASE', expiration_at_ms: null })).status, 200);
  assert.equal((await ents(u.id))[0].expires_at, null);
});

test('dev-purchase: refuses to run on a non-local deployment', () => {
  // runtime can only show the local side; the guard itself is checked in the source
  const src = readFileSync('supabase/functions/dev-purchase/index.ts', 'utf8');
  assert.match(src, /const local = \[[^\]]*'kong'[^\]]*\]\.includes\(new URL\(url\)\.hostname\)/);
  assert.match(src, /if \(!local \|\| Deno\.env\.get\('ALLOW_DEV_PURCHASES'\) !== 'true'\) return new Response\('not found', \{ status: 404 \}\)/);
});

test('dev-purchase: needs a real session and an allowed entitlement shape', async () => {
  const fn = `${URL}/functions/v1/dev-purchase`;
  const post = (auth: string, body: unknown) =>
    fetch(fn, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok([401, 404].includes((await post(KEY, { entitlement: 'all' })).status));
  const token = (await free.c.auth.getSession()).data.session!.access_token;
  for (const entitlement of ['test:%', 'test:a b', 'ALL', 'premium']) assert.ok([400, 404].includes((await post(token, { entitlement })).status), entitlement);
  assert.equal((await ents(free.id)).length, 0);
});

// ------------------------------------------------------------ 4. device and rate limits

test('device limit: one device id shared by live sessions works for one at a time and hits the cooldown', async () => {
  const owner = await user('sharer');
  assert.equal((await grant(owner.id, 'all')).status, 200);
  const read = (c: SupabaseClient) => c.rpc('get_test_questions', { p_test_id: PAID, p_device_id: DEVICE });
  assert.ifError((await read(owner.c)).error);
  const others = await Promise.all([1, 2, 3, 4].map(() => signIn(owner.email)));
  // copying the id string is not enough: the row is bound to the session that registered it
  assert.equal((await read(others[0].c)).error?.message, 'device_not_registered');
  const moves = [];
  for (const o of others) moves.push((await o.c.rpc('register_device', { p_device_id: DEVICE })).error?.message ?? 'ok');
  assert.deepEqual(moves, ['ok', 'ok', 'ok', 'device_cooldown']); // 3 changes per 30 days
  assert.equal((await read(owner.c)).error?.message, 'device_not_registered', 'the previous holder lost it');
  assert.ifError((await read(others[2].c)).error);
  assert.equal((await read(others[3].c)).error?.message, 'device_not_registered');
});

test('device limit: signing other sessions out moves a device id, but only one session reads through it', async () => {
  // Residual (open, decision Arman): signOut({ scope: 'others' }) makes a takeover free, so the
  // 3-changes cooldown can be skipped; at most 2 sessions read paid pages at any one time.
  const owner = await user('takeover');
  assert.equal((await grant(owner.id, 'all')).status, 200);
  const read = (c: SupabaseClient) => c.rpc('get_test_questions', { p_test_id: PAID, p_device_id: DEVICE }).then((r) => r.error?.message ?? 'ok');
  let prev = owner;
  for (let i = 0; i < 4; i++) {
    const next = await signIn(owner.email);
    await next.c.auth.signOut({ scope: 'others' });
    assert.ifError((await next.c.rpc('register_device', { p_device_id: DEVICE })).error);
    assert.deepEqual([await read(prev.c), await read(next.c)], ['device_not_registered', 'ok']);
    prev = next;
  }
  assert.equal(sql(`select count(*) from public.devices where user_id = '${owner.id}'`), '1');
});

test('device limit: devices cannot be deleted directly, and removal is on the cooldown', async () => {
  const u = await user('rotator');
  const del = await u.c.from('devices').delete().eq('user_id', u.id).select();
  assert.ok(del.error || del.data?.length === 0, 'direct delete must do nothing');
  assert.equal((await admin.from('devices').select('*').eq('user_id', u.id)).data!.length, 1);
  const steps = [];
  let current = DEVICE;
  for (let i = 0; i < 4; i++) {
    const r = await u.c.rpc('remove_device', { p_device_id: current });
    steps.push(r.error?.message ?? 'removed');
    if (r.error) break;
    current = `device-rot-${i}`;
    assert.ifError((await u.c.rpc('register_device', { p_device_id: current })).error);
  }
  assert.deepEqual(steps, ['removed', 'removed', 'removed', 'device_cooldown']);
});

test('device limit holds under parallel registration', async () => {
  const u = await user('racer', null);
  const r = await Promise.all(Array.from({ length: 10 }, (_, i) => u.c.rpc('register_device', { p_device_id: `device-race-${i}` })));
  assert.equal(r.filter((x) => !x.error).length, 2);
});

test('rate limit holds under 50 parallel calls', async () => {
  const u = await user('parallel');
  const r = await Promise.all(Array.from({ length: 50 }, () => u.c.rpc('get_test_questions', { p_test_id: FREE })));
  const ok = r.filter((x) => !x.error).length;
  // fixed one-minute window: a call batch straddling the minute boundary can get up to 2 windows
  assert.ok(ok <= 60, `${ok} calls passed`);
  assert.ok(r.some((x) => x.error?.message === 'rate_limited'));
});

const perMinute = () => Number(sql(`select value from private.settings where key = 'paid_calls_per_minute'`));

test('paid reads: a calls-per-minute limit and a daily cap on distinct paid questions (M3)', async () => {
  const u = await user('capper');
  assert.equal((await grant(u.id, 'all')).status, 200);
  const r = [];
  const lim = perMinute();
  assert.equal(lim, 20, 'reviewed value (20261122500000)');
  for (let i = 0; i < lim + 2; i++) r.push(await u.c.rpc('get_test_questions', { p_test_id: PAID, p_device_id: DEVICE }));
  const ok = r.filter((x) => !x.error).length;
  assert.ok(ok < lim + 2, `${ok} paid calls passed`); // a minute boundary mid-loop could split it in two windows (rare)
  assert.ok(r.some((x) => x.error?.message === 'rate_limited'));

  // daily cap (counted per UTC day since 20261121130000): pre-fill today's served rows to 597 instead of changing the shared setting
  const d = await user('dailycap');
  assert.equal((await grant(d.id, 'all')).status, 200);
  const cap = Number(sql(`select value from private.settings where key = 'paid_questions_per_day'`));
  assert.equal(cap, 600);
  sql(`insert into private.served (user_id, day, question_id)
    select '${d.id}', (now() at time zone 'UTC')::date, gen_random_uuid() from generate_series(1, ${cap - 3})`);
  const page = (t: string) => d.c.rpc('get_test_questions', { p_test_id: t, p_device_id: DEVICE });
  assert.equal((await page(PAID)).data.length, 3, 'reaching exactly the cap is allowed');
  assert.equal((await page(OTHER)).error?.message, 'daily_cap');
  assert.equal((await page(PAID)).data.length, 3, 'questions already served today stay readable');
  assert.equal(sql(`select count(*) from private.served where user_id = '${d.id}'`), String(cap), 'the refused page is not counted');
});

test('delete account: only your own, everything goes, entitlement does not survive re-signup', async () => {
  const fn = `${URL}/functions/v1/delete-account`;
  const del = (token: string, body: unknown = {}) =>
    fetch(fn, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const tokenOf = async (c: SupabaseClient) => (await c.auth.getSession()).data.session!.access_token;
  const u = await user('deleter');
  assert.equal((await grant(u.id, 'all')).status, 200);
  const q = fixture[PAID][0];
  assert.ifError((await u.c.rpc('get_test_questions', { p_test_id: PAID, p_device_id: DEVICE })).error);
  const { data: attempt } = await u.c.rpc('start_attempt', { p_test_id: PAID, p_mode: 'practice' });
  assert.ifError((await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q.id, p_choice_id: q.wrong, p_attempt_id: attempt })).error);
  assert.ifError((await u.c.from('question_flags').insert({ question_id: q.id })).error);
  assert.ifError((await u.c.from('question_reports').insert({ question_id: q.id, message: 'x' })).error);
  assert.ifError((await u.c.rpc('save_push_token', { p_token: 'tok', p_platform: 'ios' })).error);
  assert.ifError((await u.c.rpc('remove_device', { p_device_id: DEVICE })).error);
  assert.ifError((await u.c.rpc('register_device', { p_device_id: 'device-sec-2' })).error);
  const token = await tokenOf(u.c);
  const userTables = () => rows(`select table_schema || '.' || table_name from information_schema.columns
    where column_name = 'user_id' and table_schema in ('public', 'private')`);
  const counts = () => Object.fromEntries([...userTables().map((t) => [t, Number(sql(`select count(*) from ${t} where user_id = '${u.id}'`))]),
    ['public.profiles', Number(sql(`select count(*) from public.profiles where id = '${u.id}'`))]]);
  const before = counts();
  for (const t of ['public.profiles', 'public.entitlements', 'public.devices', 'public.attempts', 'public.answers', 'public.review_items',
    'public.daily_activity', 'public.question_flags', 'public.question_reports', 'public.push_tokens',
    'private.rate_limits', 'private.served', 'private.device_changes']) assert.ok(before[t] > 0, `set-up wrote no row in ${t}`);

  assert.equal((await del(KEY)).status, 401);
  assert.equal((await del(token, { password: 'wrong-password' })).status, 401);
  // naming another user in the body is ignored: a token deletes its own account only
  const other = await user('bystander', null);
  assert.equal((await del(await tokenOf(other.c), { user_id: u.id, id: u.id })).status, 200);
  assert.ok((await admin.auth.admin.getUserById(u.id)).data.user, 'the named user is untouched');
  assert.equal((await admin.auth.admin.getUserById(other.id)).data.user, null);

  assert.equal((await del(token)).status, 200); // fresh sign-in, no password needed
  // every table with a user_id column, and profiles, is empty for this user
  assert.deepEqual(Object.entries(counts()).filter(([, n]) => (n as number) > 0), []);
  assert.equal(sql(`select count(*) from auth.sessions where user_id = '${u.id}'`), '0');
  // the old token, still signed until it expires, opens nothing paid
  assert.equal((await u.c.rpc('get_test_questions', { p_test_id: PAID, p_device_id: DEVICE })).error?.message, 'no_access');
  // signing up again with the same email starts with no entitlement
  assert.ifError((await admin.auth.admin.createUser({ email: u.email, password: PASS, email_confirm: true })).error);
  const again = await signIn(u.email);
  created.push(again.id);
  assert.notEqual(again.id, u.id);
  assert.equal((await ents(again.id)).length, 0);
  assert.equal((await again.c.rpc('start_attempt', { p_test_id: PAID, p_mode: 'exam' })).error?.message, 'no_access');
});

// ------------------------------------------------------------ round four: faculty, year, library

test('study profile: catalogue for everyone (profile is a default), valid values, no wider access', async () => {
  const sub = `${TAG}-subj`;
  assert.ifError((await admin.from('subjects').insert({ id: sub, title: { en: 'sec subject' }, position: 999, faculty_id: 'pharmacy', year: 6 })).error);
  try {
    assert.ifError((await admin.from('library_items').insert({ subject_id: sub, section: 'tests', source_id: '999999', title: 'sec doc' })).error);
    const u = await user('student', null);
    assert.ifError((await u.c.from('profiles').update({ faculty_id: 'general-medicine', year: 2 }).eq('id', u.id)).error);
    type Row = { id: string; faculty_id: string | null; year: number | null; library_count: number; test_count: number };
    const list = (await u.c.rpc('list_subjects')).data as Row[];
    // every subject, other faculties and years included (catalogue metadata only), general categories last
    assert.equal(list.find((r) => r.id === sub)?.library_count, 1, 'a pharmacy year-6 subject is listed for a general-medicine year-2 student');
    assert.ok(list.every((r) => Number.isInteger(r.test_count)), 'test_count on every row');
    const firstGeneral = list.findIndex((r) => r.faculty_id === null);
    assert.ok(firstGeneral === -1 || list.slice(firstGeneral).every((r) => r.faculty_id === null), 'general categories come last');
    assert.deepEqual(Object.keys(list[0]).filter((k) => /body|question|choice|statement|explanation/.test(k)), [], 'no question content in the catalogue');
    // invalid values are refused
    assert.ok((await u.c.from('profiles').update({ year: 7 }).eq('id', u.id)).error);
    assert.ok((await u.c.from('profiles').update({ faculty_id: 'nope' }).eq('id', u.id)).error);
    // someone else's profile does not change
    const before = (await admin.from('profiles').select('faculty_id, year').eq('id', free.id).single()).data;
    await u.c.from('profiles').update({ faculty_id: 'stomatology', year: 1 }).eq('id', free.id);
    assert.deepEqual((await admin.from('profiles').select('faculty_id, year').eq('id', free.id).single()).data, before);
    // a study profile opens nothing paid
    assert.equal((await u.c.rpc('get_test_questions', { p_test_id: PAID })).error?.message, 'no_access');
    for (const c of [anon, u.c]) assert.ok(!JSON.stringify((await c.rpc('list_subjects')).data).includes('secret'));
  } finally {
    await admin.from('subjects').delete().eq('id', sub);
  }
});

test('catalogue and library: read-only, metadata columns only, no question text, links stay on books.ysmu.am', async () => {
  for (const c of [anon, free.c]) {
    assert.ok((await c.from('faculties').insert({ id: 'x', title: {}, position: 9 })).error);
    assert.ok((await c.from('library_items').insert({ subject_id: 'physiology', section: 'tests', source_id: '1', title: 'x' })).error);
    await c.from('library_items').update({ title: 'pwned' }).neq('title', '');
    await c.from('faculties').delete().neq('id', '');
    assert.ok((await c.from('subjects').insert({ id: 'x', title: {}, position: 1 })).error);
  }
  assert.equal(sql(`select count(*) from public.library_items where title = 'pwned'`), '0');
  assert.equal(sql(`select count(*) from public.faculties`), '4');
  assert.deepEqual(rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'library_items' order by 1`),
    ['file_name', 'id', 'published_at', 'section', 'size_kb', 'source_id', 'subject_id', 'title']);
  // the client builds https://books.ysmu.am/documents/<source_id>: ids must stay a plain path segment
  assert.equal(sql(`select count(*) from public.library_items where source_id !~ '^[0-9A-Za-z_-]+$'`), '0');
  assert.match(readFileSync('src/data/catalog.ts', 'utf8'), /const LIBRARY = 'https:\/\/books\.ysmu\.am';[\s\S]*url: `\$\{LIBRARY\}\/documents\/\$\{l\.source_id\}`/);
  // no question body (ours, any language) appears in a library title or file name
  assert.equal(sql(`select count(*) from public.library_items l join public.questions q
    on length(q.body) > 20 and (position(q.body in l.title) > 0 or position(q.body in coalesce(l.file_name, '')) > 0)`), '0');
});

test('library index script: navigation only, polite, metadata only', () => {
  const src = readFileSync('scripts/library-index.mjs', 'utf8');
  // every request goes to the home page, the language switch or the site's update endpoint
  const targets = [...src.matchAll(/await request\(([^,)]+)/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(targets, ['`${BASE}/`', '`${BASE}/locale/${locale}`', 's.updateUri'].sort());
  assert.ok(!/\/(read|download)\b/.test(src.replace(/^\/\/.*$/gm, '')), 'a /read or /download path in code');
  assert.match(src, /const BASE = 'https:\/\/books\.ysmu\.am';/);
  assert.match(src, /'User-Agent': UA/);
  assert.match(src, /const UA = 'MedPrepLibraryIndex\/[^']+';/);
  assert.match(src, /last \+ 1000 - Date\.now\(\)/, 'at most one request a second');
  assert.match(src, /if \(res\.status === 403 \|\| res\.status === 429\) throw new Error\(`stopping/, 'a refusal ends the run at once');
  assert.ok(src.includes("if (u.origin !== BASE || /\\/(read|download)\\b|\\/documents\\//.test(u.pathname)) throw"), 'the update endpoint must stay on the site');
  // cached output, when present: metadata fields only, short titles, site document ids
  if (existsSync('supabase/library/ysmu.json')) {
    const cat = JSON.parse(readFileSync('supabase/library/ysmu.json', 'utf8'));
    assert.equal(cat.source, 'https://books.ysmu.am');
    for (const l of cat.library) {
      assert.deepEqual(Object.keys(l).sort(), ['fileName', 'id', 'publishedAt', 'section', 'sizeKb', 'subject', 'title']);
      assert.match(l.id, /^\d+$/);
      assert.ok(l.title.length <= 400, `long title: ${l.title.slice(0, 60)}`);
    }
    const seed = readFileSync('supabase/library/seed.sql', 'utf8');
    assert.ok(!/https?:\/\/(?!books\.ysmu\.am)/.test(seed), 'a link to another host in the seed');
  }
});

// ------------------------------------------------------------ round five: question kinds

test('compound statements: nothing reaches unentitled users through any RPC, error or embed', async () => {
  const lapsed = await user('kinds-lapsed');
  assert.equal((await grant(lapsed.id, `test:${KINDS}`)).status, 200);
  assert.equal((await lapsed.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: KQ.wrong })).data, false);
  assert.ifError((await lapsed.c.from('question_flags').insert({ question_id: KQ.id })).error);
  await webhook(SECRET, event({ type: 'EXPIRATION', app_user_id: lapsed.id, entitlement_ids: [`test:${KINDS}`] }));
  const seen: unknown[] = [];
  for (const [c, who] of [[anon, 'anon'], [free.c, 'free'], [lapsed.c, 'lapsed'], [buyer.c, 'buyer of another test']] as const) {
    const calls: [string, Record<string, unknown>][] = [
      ['get_test_questions', { p_test_id: KINDS, p_device_id: DEVICE }],
      ['get_test_questions', { p_test_id: KINDS, p_device_id: DEVICE, p_lang: 'hy' }],
      ['list_tests', { p_subject_id: 'physiology' }], ['list_subjects', {}],
      ['get_review_list', { p_device_id: DEVICE }], ['get_review_questions', { p_device_id: DEVICE }],
      ['list_flagged', { p_device_id: DEVICE }], ['subject_stats', { p_subject_id: 'physiology' }], ['get_engagement', {}],
      ['submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: KQ.right }],
      ['submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: KQ.wrong }],
      ['start_attempt', { p_test_id: KINDS, p_mode: 'exam' }],
    ];
    for (const [fn, args] of calls) seen.push(who, fn, await c.rpc(fn, args));
    seen.push(who, await c.from('questions').select('statements, choices(combo, is_correct)').eq('test_id', KINDS));
    seen.push(who, await c.from('tests').select('questions(statements)').eq('id', KINDS));
  }
  const all = JSON.stringify(seen);
  assert.ok(!all.includes(`${KINDS} secret`), 'statement, stem or explanation text leaked');
  assert.ok(!/"combo"|"correct":(true|false)/.test(all), 'combo or statement correctness leaked'); // subject_stats has a numeric "correct" count
  // a locked compound question answers right and wrong the same way
  const r = await free.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: KQ.right });
  const w = await free.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: KQ.wrong });
  assert.deepEqual([r.error?.message, w.error?.message, r.data, w.data], ['no_access', 'no_access', null, null]);
});

test('compound questions: graded by choice id, statements and combos served only to the entitled', async () => {
  const u = await user('kinds-buyer');
  assert.equal((await grant(u.id, `test:${KINDS}`)).status, 200);
  const page = (await u.c.rpc('get_test_questions', { p_test_id: KINDS, p_device_id: DEVICE })).data;
  assert.equal(page[0].kind, 'compound');
  assert.deepEqual(page[0].statements.map((s: { n: number; text: string }) => [s.n, s.text]), [1, 2, 3, 4].map((n) => [n, `${KINDS} secret statement ${n}`]));
  assert.deepEqual(page[0].choices.map((c: { combo: number[] }) => c.combo), [[1, 2], [1, 3, 4], [4]]);
  // statement correctness follows the keyed option (1, 3, 4); like choices[].is_correct it is in the page
  assert.deepEqual(page[0].statements.map((s: { correct: boolean }) => s.correct), [true, false, true, true]);
  // a choice of another question, or a forged combo argument, does not grade
  const other = fixture[FREE][0];
  assert.equal((await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: other.right })).error?.message, 'bad_choice');
  assert.ok((await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: KQ.wrong, p_combo: [1, 3, 4] })).error);
  assert.equal((await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: KQ.wrong })).data, false);
  assert.equal((await u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: KQ.id, p_choice_id: KQ.right })).data, true);
  // the review item for the miss carries the statements and the user's combo
  const item = (await u.c.rpc('get_review_list', { p_device_id: DEVICE })).data.find((i: { questionId: string }) => i.questionId === KQ.id);
  assert.ok(item === undefined || (item.kind === 'compound' && item.statements.length === 4));
});

// ------------------------------------------------------------ full mock exam (20261122300000)

const paperTests = (attempt: string) => rows(`select t.id || '|' || t.is_free from private.exam_papers p
  join public.questions q on q.id = p.question_id join public.tests t on t.id = q.test_id where p.attempt_id = '${attempt}'`);

test('full exam: a free user draws and reads free questions only; info carries counts only', async () => {
  const u = await user('fullfree');
  const info = (await u.c.rpc('full_exam_info', { p_subject_id: 'physiology', p_lang: 'en' })).data;
  assert.deepEqual(Object.keys(info).sort(), ['available', 'last', 'minutes', 'offered', 'open', 'questions']);
  for (const c of [anon, u.c]) assert.ok(!JSON.stringify((await c.rpc('full_exam_info', { p_subject_id: 'physiology' })).data).includes('secret'));
  assert.equal((await anon.rpc('start_full_exam', { p_subject_id: 'physiology' })).error?.code, '42501', 'anon cannot start');
  const { data: st, error } = await u.c.rpc('start_full_exam', { p_subject_id: 'physiology', p_lang: 'en' });
  assert.ifError(error);
  const paper = paperTests(st.attemptId);
  assert.ok(paper.length > 0 && paper.every((r) => r.endsWith('|true')), `paid test in a free paper: ${paper.filter((r) => r.endsWith('|false'))}`);
  // every page, including a huge limit and a negative offset, is at most 10 and free
  const all: { id: string }[] = [];
  for (let off = 0; off < st.total; off += 10) all.push(...(await u.c.rpc('get_full_exam_questions', { p_attempt_id: st.attemptId, p_offset: off })).data);
  assert.equal(all.length, st.total);
  assert.equal((await u.c.rpc('get_full_exam_questions', { p_attempt_id: st.attemptId, p_limit: 1000 })).data.length, Math.min(10, st.total));
  assert.deepEqual((await u.c.rpc('get_full_exam_questions', { p_attempt_id: st.attemptId, p_offset: -5, p_limit: 3 })).data.map((q: { id: string }) => q.id), all.slice(0, 3).map((q) => q.id));
  const paidIds = [...fixture[PAID], ...fixture[OTHER]].map((f) => f.id).concat(KQ.id);
  assert.ok(all.every((q) => !paidIds.includes(q.id)), 'a paid fixture question was served to a free user');
  // starting again resumes the same paper
  assert.equal((await u.c.rpc('start_full_exam', { p_subject_id: 'physiology', p_lang: 'en' })).data.attemptId, st.attemptId);
  // the paper and other users' attempts are out of reach
  assert.ok((await u.c.schema('private' as 'public').from('exam_papers').select('*')).error);
  for (const c of [payer.c, anon]) assert.ok((await c.rpc('get_full_exam_questions', { p_attempt_id: st.attemptId })).error, 'another caller reads the paper');
  assert.equal((await payer.c.rpc('get_full_exam_questions', { p_attempt_id: st.attemptId })).error?.message, 'bad_attempt');
  // clients cannot create or rewrite attempts to point at a subject
  assert.ok((await u.c.from('attempts').insert({ user_id: u.id, subject_id: 'physiology', mode: 'exam', lang: 'en', deadline: new Date().toISOString() })).error);
  await u.c.from('attempts').update({ subject_id: 'physiology', test_id: null }).eq('user_id', u.id);
  assert.equal(sql(`select count(*) from public.attempts where user_id = '${u.id}' and subject_id is not null`), '1');
});

test('full exam: answers only into its own paper, none after submit or time; total is the paper', async () => {
  const u = await user('fullans');
  assert.equal((await grant(u.id, 'all')).status, 200);
  const { data: st } = await u.c.rpc('start_full_exam', { p_subject_id: 'physiology', p_lang: 'en' });
  const inPaper = new Set(rows(`select question_id from private.exam_papers where attempt_id = '${st.attemptId}'`));
  const ans = (q: string, c: string, a = st.attemptId) => u.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: q, p_choice_id: c, p_attempt_id: a });
  // a question the user can open but that is not on the paper (another subject or language) is refused
  const out = sql(`select q.id || '|' || c.id from public.questions q join public.choices c on c.question_id = q.id join public.tests t on t.id = q.test_id
    where t.is_free and q.id not in (select question_id from private.exam_papers where attempt_id = '${st.attemptId}') limit 1`).split('|');
  assert.ok(out[0] && !inPaper.has(out[0]));
  assert.equal((await ans(out[0], out[1])).error?.message, 'bad_attempt');
  const first = [...inPaper][0];
  const c = sql(`select id from public.choices where question_id = '${first}' limit 1`);
  assert.ifError((await ans(first, c)).error);
  // someone else cannot answer into it
  assert.equal((await payer.c.rpc('submit_answer', { p_id: crypto.randomUUID(), p_question_id: first, p_choice_id: c, p_attempt_id: st.attemptId })).error?.message, 'bad_attempt');
  const done = (await u.c.rpc('finish_attempt', { p_attempt_id: st.attemptId })).data;
  assert.equal(done.total, inPaper.size, 'total is the paper size');
  assert.equal((await ans(first, c)).error?.message, 'attempt_closed');
  // the server's clock: past deadline + 2 min nothing is accepted, and the attempt is no longer resumable
  const { data: late } = await u.c.rpc('start_full_exam', { p_subject_id: 'physiology', p_lang: 'en' });
  assert.notEqual(late.attemptId, st.attemptId);
  sql(`update public.attempts set deadline = now() - interval '3 minutes' where id = '${late.attemptId}'`);
  const q2 = sql(`select question_id from private.exam_papers where attempt_id = '${late.attemptId}' limit 1`);
  assert.equal((await ans(q2, sql(`select id from public.choices where question_id = '${q2}' limit 1`), late.attemptId)).error?.message, 'time_up');
});

test('full exam: paid pages need the entitlement now, the bound device, and count toward rate and daily cap', async () => {
  const u = await user('fullpaid');
  assert.equal((await grant(u.id, 'all')).status, 200);
  const { data: st } = await u.c.rpc('start_full_exam', { p_subject_id: 'physiology', p_lang: 'en' });
  const paidAt = rows(`select p.position from private.exam_papers p join public.questions q on q.id = p.question_id
    join public.tests t on t.id = q.test_id where p.attempt_id = '${st.attemptId}' and not t.is_free order by 1`).map(Number);
  assert.ok(paidAt.length > 0, 'an entitled paper has paid questions');
  const off = paidAt[0] - 1;
  const page = (dev: string | null = DEVICE, c = u.c) => c.rpc('get_full_exam_questions', { p_attempt_id: st.attemptId, p_device_id: dev, p_offset: off, p_limit: 1 });
  assert.equal((await page(null)).error?.message, 'device_not_registered');
  assert.equal((await page('some-other-device')).error?.message, 'device_not_registered');
  assert.equal((await page()).data.length, 1);
  assert.ok(Number(sql(`select count(*) from private.served where user_id = '${u.id}'`)) >= 1, 'a paid page is counted toward the daily cap');
  // calls per minute: the same fixed window as get_test_questions
  const r = [];
  for (let i = 0; i < perMinute() + 2; i++) r.push(await page());
  assert.ok(r.some((x) => x.error?.message === 'rate_limited'), 'paid paper pages are rate limited');
  // entitlement lapses after the draw: paid pages close, the paper is not a way around it
  const d = await user('fulllapse');
  assert.equal((await grant(d.id, 'all')).status, 200);
  const { data: ds } = await d.c.rpc('start_full_exam', { p_subject_id: 'physiology', p_lang: 'en' });
  const dPaid = Number(sql(`select min(p.position) from private.exam_papers p join public.questions q on q.id = p.question_id
    join public.tests t on t.id = q.test_id where p.attempt_id = '${ds.attemptId}' and not t.is_free`));
  await admin.from('entitlements').update({ expires_at: new Date(Date.now() - 60e3).toISOString() }).eq('user_id', d.id);
  assert.equal((await d.c.rpc('get_full_exam_questions', { p_attempt_id: ds.attemptId, p_device_id: DEVICE, p_offset: dPaid - 1, p_limit: 1 })).error?.message, 'no_access');
  // daily cap on paper pages: pre-fill to the cap, then a new paid question is refused
  const cap = Number(sql(`select value from private.settings where key = 'paid_questions_per_day'`));
  const k = await user('fullcap');
  assert.equal((await grant(k.id, 'all')).status, 200);
  const { data: ks } = await k.c.rpc('start_full_exam', { p_subject_id: 'physiology', p_lang: 'en' });
  sql(`insert into private.served (user_id, day, question_id) select '${k.id}', private.user_today('${k.id}'), gen_random_uuid() from generate_series(1, ${cap})`);
  const kPaid = Number(sql(`select min(p.position) from private.exam_papers p join public.questions q on q.id = p.question_id
    join public.tests t on t.id = q.test_id where p.attempt_id = '${ks.attemptId}' and not t.is_free`));
  assert.equal((await k.c.rpc('get_full_exam_questions', { p_attempt_id: ks.attemptId, p_device_id: DEVICE, p_offset: kPaid - 1, p_limit: 1 })).error?.message, 'daily_cap');
});

test('exam mode tells the learner nothing about correctness before submit, by any channel', async () => {
  const u = await user('fullpeek');
  assert.equal((await grant(u.id, 'all')).status, 200);
  const [q0, q1] = fixture[PAID];
  const ans = (a: string, q: string, c: string, id = crypto.randomUUID()) =>
    u.c.rpc('submit_answer', { p_id: id, p_question_id: q, p_choice_id: c, p_attempt_id: a });
  // everything that could carry correctness (counts of answered questions may move, they say nothing about right or wrong)
  const channels = async () => {
    const e = (await u.c.rpc('get_engagement')).data, st = (await u.c.rpc('subject_stats', { p_subject_id: 'physiology' })).data;
    return JSON.stringify([e.xp, e.level, e.xpIntoLevel, st.correct, st.readiness, st.topics.map((t: { correct: number; accuracy: number }) => [t.correct, t.accuracy]),
      ((await u.c.from('daily_activity').select('correct, xp')).data ?? []).reduce((n, d) => n + d.correct + d.xp, 0),
      (await u.c.rpc('get_review_list', { p_device_id: DEVICE })).data, (await u.c.rpc('review_due_count')).data]);
  };
  const before = await channels();
  // a test exam: right and wrong answers both return null, a replay too, and nothing else moves
  const { data: a } = await u.c.rpc('start_attempt', { p_test_id: PAID, p_mode: 'exam' });
  const replay = crypto.randomUUID();
  const r = [await ans(a, q0.id, q0.right, replay), await ans(a, q1.id, q1.wrong), await ans(a, q0.id, q0.right, replay)];
  assert.deepEqual(r.map((x) => [x.error?.message, x.data]), [[undefined, null], [undefined, null], [undefined, null]]);
  // a full exam the same
  const { data: st } = await u.c.rpc('start_full_exam', { p_subject_id: 'physiology', p_lang: 'en' });
  const fq = sql(`select p.question_id || '|' || c.id from private.exam_papers p join public.choices c on c.question_id = p.question_id
    where p.attempt_id = '${st.attemptId}' and c.is_correct limit 1`).split('|');
  assert.equal((await ans(st.attemptId, fq[0], fq[1])).data, null);
  assert.equal(await channels(), before, 'engagement, stats, activity, review moved during an open exam');
  // the answers table: own rows, no correctness or xp, practice included
  assert.ok((await u.c.from('answers').select('*')).error, 'select * on answers');
  for (const col of ['is_correct', 'xp']) assert.ok((await u.c.from('answers').select(col)).error, `answers.${col} readable`);
  const own = (await u.c.from('answers').select('id, user_id, attempt_id, question_id, choice_id, answered_at, received_at, day, counted').eq('attempt_id', a)).data!;
  assert.equal(own.length, 2); // the replay is the same row
  assert.ok((await anon.from('answers').select('id')).error, 'anon reads answers');
  assert.deepEqual((await free.c.from('answers').select('id').eq('attempt_id', a)).data, [], 'another user sees the rows');
  // submit credits the final answers: xp now, and a replay after submit returns the result
  await u.c.rpc('finish_attempt', { p_attempt_id: a });
  assert.ok((await u.c.rpc('get_engagement')).data.xp > JSON.parse(before)[0], 'xp credited at submit');
  assert.equal((await ans(a, q0.id, q0.right, replay)).data, true);
});

test('no free question repeats a paid question or option of the same language', () => {
  const dup = rows(`select f.test_id || ' = ' || p.test_id || ' (' || f.lang || '): ' || left(f.body, 60)
    from public.questions f join public.tests tf on tf.id = f.test_id and tf.is_free
    join public.questions p on p.body = f.body and p.lang = f.lang join public.tests tp on tp.id = p.test_id and not tp.is_free
    where f.test_id !~ '^sec[0-9]'
    union all
    select f.test_id || ' = ' || p.test_id || ' option (' || f.lang || '): ' || left(fc.body, 60)
    from public.questions f join public.tests tf on tf.id = f.test_id and tf.is_free join public.choices fc on fc.question_id = f.id
    join public.choices pc on pc.body = fc.body
    join public.questions p on p.id = pc.question_id and p.lang = f.lang join public.tests tp on tp.id = p.test_id and not tp.is_free and tp.subject_id = tf.subject_id
    -- a real answer text: several words, longer than 12 characters, not a combination like "1, 2, 3"
    where f.test_id !~ '^sec[0-9]' and fc.combo is null and length(fc.body) > 12 and fc.body ~ '\\S\\s+\\S' and fc.body !~ '^[0-9 ,]+$'`);
  assert.deepEqual(dup, [], 'a free question shows a paid question\'s text');
});

// ------------------------------------------------------------ 5. secrets

test('no secrets in git history or tracked files', () => {
  const tracked = execSync('git ls-files').toString().split('\n');
  assert.ok(!tracked.some((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')), 'env file tracked');
  const history = execSync('git log --all -p --no-color', { maxBuffer: 512 * 1024 * 1024 }).toString();
  for (const s of [SECRET, status.SERVICE_ROLE_KEY, status.SECRET_KEY, status.JWT_SECRET]) assert.ok(!history.includes(s));
  assert.ok(!/sb_secret_[A-Za-z0-9_-]{10,}|service_role"\s*:\s*"eyJ|-----BEGIN (RSA |EC )?PRIVATE KEY/.test(history));
});
