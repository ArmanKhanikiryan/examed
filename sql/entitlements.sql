-- Pricing: buy one subject or one course year (every subject of a faculty + year).
-- Two entitlement kinds next to 'all' and 'test:<id>':
--   'subject:<subjects.id>'          every paid test of that subject
--   'year:<faculty_id>:<year>'       every paid test of every subject with that faculty and year
-- The only access check is private.can_access_test; every guarded read and write calls it.

alter table public.entitlements drop constraint entitlements_entitlement_check;
alter table public.entitlements add constraint entitlements_entitlement_check check (
  entitlement = 'all' or entitlement like 'test:%'
  or entitlement ~ '^subject:[^:]+$' or entitlement ~ '^year:[^:]+:[1-6]$');

-- Same signature, so existing grants stay. A subject without faculty or year has a null year key.
create or replace function private.can_access_test(p_test_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tests t join public.subjects s on s.id = t.subject_id
    where t.id = p_test_id
      and (t.is_free or exists (
        select 1 from public.entitlements e
        where e.user_id = auth.uid()
          and e.entitlement in ('all', 'test:' || t.id, 'subject:' || s.id, 'year:' || s.faculty_id || ':' || s.year)
          and (e.expires_at is null or e.expires_at > now())
      ))
  )
$$;

-- Display prices until the stores are set up. Change here.
insert into private.settings (key, value) values
  ('price_subject_amd', 2000),
  ('price_year_amd', 9900);

-- Webhook: same as 20261121120000 except the accepted entitlement kinds.
create or replace function public.apply_revenuecat_event(p_body jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  ev jsonb := p_body -> 'event';
  v_type text := ev ->> 'type';
  v_user uuid;
  v_expires timestamptz;
  v_ents jsonb := case when jsonb_typeof(ev -> 'entitlement_ids') = 'array' then ev -> 'entitlement_ids' else '[]' end;
  v_ent text;
begin
  if ev is null or ev ->> 'id' is null then raise exception 'bad_payload' using errcode = 'P0001'; end if;
  begin
    v_expires := to_timestamp((ev ->> 'expiration_at_ms')::bigint / 1000.0);
  exception when others then
    raise exception 'bad_payload' using errcode = 'P0001';
  end;
  insert into private.webhook_events (id) values (ev ->> 'id') on conflict do nothing;
  if not found then return 'duplicate'; end if;

  begin
    v_user := (ev ->> 'app_user_id')::uuid;
  exception when invalid_text_representation then
    return 'ignored: app_user_id is not a user id';
  end;
  if not exists (select 1 from auth.users where id = v_user) then return 'ignored: unknown user'; end if;

  -- ponytail: TRANSFER and PRODUCT_CHANGE are ignored; handle them when real products exist
  if v_type in ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE', 'UNCANCELLATION',
                'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT', 'REFUND_REVERSED') then
    if v_expires is null and v_ents ? 'all' then raise exception 'bad_payload' using errcode = 'P0001'; end if;
    for v_ent in select x from jsonb_array_elements_text(v_ents) x
                 where x = 'all' or x like 'test:%' or x ~ '^subject:[^:]+$' or x ~ '^year:[^:]+:[1-6]$' loop
      insert into public.entitlements (user_id, entitlement, expires_at, source, updated_at)
      values (v_user, v_ent, v_expires, 'revenuecat', now())
      on conflict (user_id, entitlement) do update set expires_at = excluded.expires_at, updated_at = now();
    end loop;
    return 'granted';
  elsif v_type = 'EXPIRATION' or (v_type = 'CANCELLATION' and ev ->> 'cancel_reason' = 'CUSTOMER_SUPPORT') then
    update public.entitlements set expires_at = now(), updated_at = now()
    where user_id = v_user
      and entitlement in (select jsonb_array_elements_text(v_ents));
    return 'revoked';
  end if;
  return 'ignored: ' || coalesce(v_type, 'no type');
end $$;

create function private.owns(p_entitlement text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.entitlements e
    where e.user_id = auth.uid() and e.entitlement = p_entitlement
      and (e.expires_at is null or e.expires_at > now()))
$$;

-- Paywall: what the caller would buy and what they already own. Counts only, no question text.
-- Question counts are for one content language (one row per language). year_counts and the
-- year entitlement are null when the subject has no faculty or year.
create function public.paywall_info(p_subject_id text, p_lang text default 'hy') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.subjects;
  v_year text;
begin
  select * into s from public.subjects where id = p_subject_id;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  v_year := 'year:' || s.faculty_id || ':' || s.year;
  return jsonb_build_object(
    'subject', jsonb_build_object('id', s.id, 'title', s.title, 'faculty_id', s.faculty_id,
      'faculty_title', (select f.title from public.faculties f where f.id = s.faculty_id), 'year', s.year),
    'subject_counts', (select jsonb_build_object('paid_tests', count(distinct t.id), 'paid_questions', count(q.id))
      from public.tests t left join public.questions q on q.test_id = t.id and q.lang = p_lang
      where t.subject_id = s.id and not t.is_free),
    'year_counts', case when v_year is not null then (
      select jsonb_build_object('subjects', count(distinct ys.id), 'paid_tests', count(distinct t.id), 'paid_questions', count(q.id))
      from public.subjects ys join public.tests t on t.subject_id = ys.id and not t.is_free
      left join public.questions q on q.test_id = t.id and q.lang = p_lang
      where ys.faculty_id = s.faculty_id and ys.year = s.year) end,
    'owns', jsonb_build_object('subject', private.owns('subject:' || s.id),
      'year', coalesce(private.owns(v_year), false), 'all', private.owns('all')),
    'prices', jsonb_build_object('subject_amd', private.setting('price_subject_amd'),
      'year_amd', private.setting('price_year_amd')),
    'entitlements', jsonb_build_object('subject', 'subject:' || s.id, 'year', v_year));
end $$;

revoke execute on function private.owns(text), public.paywall_info(text, text) from public, anon, authenticated;
grant execute on function public.paywall_info(text, text) to authenticated;
