-- An exam (a test's or a full exam) tells the learner nothing about correctness before submit:
-- submit_answer returns null, exam answers earn XP and "correct" at finish_attempt (from the
-- final answer), stats and the review list skip answers of an open exam, and clients cannot read
-- is_correct or xp on answers rows at all (statistics come from the RPCs). Practice is unchanged.

-- an unfinished exam still inside its time limit and grace
create function private.exam_open(p_attempt_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.attempts where id = p_attempt_id and mode = 'exam'
                 and finished_at is null and now() <= deadline + interval '2 minutes')
$$;
revoke execute on function private.exam_open(uuid) from public, anon, authenticated;

revoke select on public.answers from anon, authenticated;
grant select (id, user_id, attempt_id, question_id, choice_id, answered_at, received_at, day, counted)
  on public.answers to authenticated;

create or replace function public.submit_answer(p_id uuid, p_question_id uuid, p_choice_id uuid,
  p_attempt_id uuid default null, p_answered_at timestamptz default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_correct boolean; v_test text; v_tz text; v_goal int; v_at timestamptz; v_day date;
  v_counted boolean; v_xp int; v_att public.attempts; v_replay uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  -- one writer per user, so two devices cannot both count the same question as new
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));

  -- a replay: the stored result, hidden while its exam is open
  select is_correct, attempt_id into v_correct, v_replay from public.answers where id = p_id and user_id = auth.uid();
  if found then return case when private.exam_open(v_replay) then null else v_correct end; end if;

  select q.test_id, c.is_correct into v_test, v_correct
  from public.choices c join public.questions q on q.id = c.question_id
  where c.id = p_choice_id and q.id = p_question_id;
  if v_test is null then raise exception 'bad_choice' using errcode = 'P0001'; end if;
  if not private.can_access_test(v_test) then raise exception 'no_access' using errcode = 'P0001'; end if;
  if p_attempt_id is not null then
    select * into v_att from public.attempts where id = p_attempt_id and user_id = auth.uid()
      and (test_id = v_test or exists (select 1 from private.exam_papers p
                                       where p.attempt_id = p_attempt_id and p.question_id = p_question_id));
    if not found then raise exception 'bad_attempt' using errcode = 'P0001'; end if;
    if v_att.mode = 'exam' and v_att.finished_at is not null then
      raise exception 'attempt_closed' using errcode = 'P0001';
    end if;
    -- 2 minutes of grace for answers still in flight when the timer ends
    if v_att.mode = 'exam' and now() > v_att.deadline + interval '2 minutes' then
      raise exception 'time_up' using errcode = 'P0001';
    end if;
  end if;

  select timezone, daily_goal into v_tz, v_goal from public.profiles where id = auth.uid();
  -- ponytail: offline answers may be dated up to 48 h back, so a client can still fill
  -- yesterday by backdating; tighten to the attempt start if that gets abused
  v_at := least(greatest(coalesce(p_answered_at, now()), now() - interval '48 hours'), now());
  v_day := (v_at at time zone v_tz)::date;
  v_counted := not exists (select 1 from public.answers
    where user_id = auth.uid() and question_id = p_question_id and day = v_day);
  -- XP for the first correct answer of the day; an exam answer earns it at submit (finish_attempt)
  v_xp := (v_correct and v_att.mode is distinct from 'exam' and not exists (select 1 from public.answers
    where user_id = auth.uid() and question_id = p_question_id and day = v_day and xp > 0))::int;

  insert into public.answers (id, user_id, attempt_id, question_id, choice_id, is_correct, answered_at, day, counted, xp)
  values (p_id, auth.uid(), p_attempt_id, p_question_id, p_choice_id, v_correct, v_at, v_day, v_counted, v_xp);

  insert into public.daily_activity as d (user_id, day, answered, correct, xp, goal, goal_met)
  values (auth.uid(), v_day, v_counted::int, v_xp, v_xp, v_goal, v_counted::int >= v_goal)
  on conflict (user_id, day) do update set
    answered = d.answered + excluded.answered,
    correct = d.correct + excluded.correct,
    xp = d.xp + excluded.xp,
    goal_met = d.goal_met or d.answered + excluded.answered >= d.goal;

  if v_att.mode is distinct from 'exam' then
    perform private.review_answer(auth.uid(), p_question_id, v_correct);
    return v_correct;
  end if;
  return null; -- an exam says nothing about correctness before submit
end $$;

create or replace function public.finish_attempt(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_a public.attempts; v_exam boolean; v_correct int; v_total int; v_answered int; v_today date;
  v_bonus int := 0; v_xp int; v_all_xp int; v_day public.daily_activity; v_just_met boolean; s record; f record;
begin
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select * into v_a from public.attempts where id = p_attempt_id and user_id = auth.uid();
  if not found then raise exception 'bad_attempt' using errcode = 'P0001'; end if;
  if v_a.finished_at is not null then
    return jsonb_build_object('correct', v_a.correct, 'total', v_a.total, 'gain', v_a.gain);
  end if;
  v_exam := v_a.mode = 'exam';

  v_correct := 0; v_answered := 0;
  for f in
    select distinct on (a.question_id) a.id, a.question_id, a.is_correct, a.day from public.answers a
    where a.attempt_id = v_a.id
    order by a.question_id, case when v_exam then a.received_at end desc, a.received_at
  loop
    v_answered := v_answered + 1;
    v_correct := v_correct + f.is_correct::int;
    if v_exam then
      perform private.review_answer(auth.uid(), f.question_id, f.is_correct);
      -- the final answer earns the day's XP for the question, if nothing did yet
      if f.is_correct and not exists (select 1 from public.answers where user_id = auth.uid()
                                      and question_id = f.question_id and day = f.day and xp > 0) then
        update public.answers set xp = 1 where id = f.id;
        update public.daily_activity set correct = correct + 1, xp = xp + 1 where user_id = auth.uid() and day = f.day;
      end if;
    end if;
  end loop;
  if v_a.subject_id is not null then
    select count(*) into v_total from private.exam_papers where attempt_id = v_a.id;
  else
    select count(*) into v_total from public.questions q where q.test_id = v_a.test_id and q.lang = v_a.lang;
  end if;

  v_today := private.user_today(auth.uid());
  if v_total > 0 and v_answered >= v_total and not exists (
    select 1 from public.attempts where user_id = auth.uid() and bonus_day = v_today
      and (test_id = v_a.test_id or subject_id = v_a.subject_id)
  ) then
    v_bonus := 10;
    v_a.bonus_day := v_today;
    insert into public.daily_activity as d (user_id, day, xp, goal)
    values (auth.uid(), v_today, v_bonus, (select daily_goal from public.profiles where id = auth.uid()))
    on conflict (user_id, day) do update set xp = d.xp + excluded.xp;
  end if;

  select coalesce(sum(xp), 0) + v_bonus into v_xp from public.answers where attempt_id = v_a.id;
  select coalesce(sum(xp), 0) into v_all_xp from public.daily_activity where user_id = auth.uid();
  select * into v_day from public.daily_activity where user_id = auth.uid() and day = v_today;
  v_just_met := coalesce(v_day.goal_met, false) and v_day.answered - (select count(*) from public.answers
    where attempt_id = v_a.id and day = v_today and counted) < v_day.goal;
  s := private.engagement_state(auth.uid(), v_today);

  v_a.gain := jsonb_build_object(
    'xp', v_xp,
    'levelUp', private.level(v_all_xp) > private.level(v_all_xp - v_xp),
    'streakExtended', v_just_met,
    'newStreak', s.streak,
    'goalJustMet', v_just_met,
    'freezeEarned', v_just_met and s.freeze_earned_today);
  update public.attempts set correct = v_correct, total = v_total, finished_at = now(),
    gain = v_a.gain, bonus_day = v_a.bonus_day
  where id = v_a.id;
  return jsonb_build_object('correct', v_correct, 'total', v_total, 'gain', v_a.gain);
end $$;

create or replace function public.subject_stats(p_subject_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with qs as (
    select q.id, q.test_id, q.position, q.topic_id from public.questions q
    join public.tests t on t.id = q.test_id where t.subject_id = p_subject_id
  ), mine as (
    select a.is_correct, a.answered_at, qs.test_id, qs.position, qs.topic_id
    from public.answers a join qs on qs.id = a.question_id
    where a.user_id = auth.uid() and not private.exam_open(a.attempt_id)
  ), latest as (
    select distinct on (test_id, position) is_correct from mine order by test_id, position, answered_at desc
  ), topics as (
    select tp.id, tp.title, count(m.is_correct)::int answered, count(*) filter (where m.is_correct)::int correct
    from public.topics tp left join mine m on m.topic_id = tp.id
    where tp.subject_id = p_subject_id group by tp.id, tp.title
  )
  select jsonb_build_object(
    'subjectId', p_subject_id,
    'readiness', coalesce(round(100.0 * (select count(*) from latest where is_correct)
                   / nullif((select count(*) from (select distinct test_id, position from qs) k), 0)), 0)::int,
    'passMark', (select pass_mark from public.subjects where id = p_subject_id),
    'answered', (select count(*) from mine),
    'correct', (select count(*) from mine where is_correct),
    'topics', coalesce((select jsonb_agg(jsonb_build_object('topicId', id, 'title', title, 'answered', answered,
        'correct', correct, 'accuracy', coalesce(round(100.0 * correct / nullif(answered, 0)), 0)::int)
      order by answered = 0, correct::numeric / nullif(answered, 0), id) from topics), '[]'::jsonb))
$$;

create or replace function public.get_review_list(p_device_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  perform private.check_rate_limit();
  if exists (select 1 from public.review_items r join public.questions q on q.id = r.question_id
             join public.tests t on t.id = q.test_id where r.user_id = auth.uid() and not t.is_free) then
    perform private.check_device(p_device_id);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'questionId', q.id, 'kind', q.kind, 'body', q.body,
      'statements', private.question_json(q) -> 'statements',
      'yourAnswer', (select c.body from public.answers a join public.choices c on c.id = a.choice_id
                     where a.user_id = auth.uid() and a.question_id = q.id and not a.is_correct
                       and not private.exam_open(a.attempt_id)
                     order by a.received_at desc limit 1),
      'yourCombo', (select c.combo from public.answers a join public.choices c on c.id = a.choice_id
                    where a.user_id = auth.uid() and a.question_id = q.id and not a.is_correct
                      and not private.exam_open(a.attempt_id)
                    order by a.received_at desc limit 1),
      'correctAnswer', (select c.body from public.choices c where c.question_id = q.id and c.is_correct limit 1),
      'box', r.box, 'subjectId', t.subject_id, 'subject', s.title, 'testId', t.id, 'unit', t.title,
      'unitPosition', t.position, 'dueAt', r.due_at, 'due', r.due_at <= now()) order by r.due_at)
    from (select * from public.review_items where user_id = auth.uid() order by due_at limit 100) r
    join public.questions q on q.id = r.question_id
    join public.tests t on t.id = q.test_id
    join public.subjects s on s.id = t.subject_id
    where private.can_access_test(q.test_id)
  ), '[]'::jsonb);
end $$;
