-- 477_lock_submission_insert.sql — #477: a signed-in user could insert a
-- submission that was already `approved` (or pre-classified, pre-reviewed,
-- pre-merged, backdated), skipping the AI gate and moderation. Run in the
-- Supabase SQL editor, whole file. Idempotent — safe to re-run.
--
-- WHY. The INSERT policy `insert own submissions` checks only
-- auth.uid() = submitted_by, `authenticated` holds a table-level INSERT
-- grant, and no trigger touched server-owned columns on insert
-- (lock_resolved_desc_columns covers only resolved_*). RLS is row-level: it
-- cannot say "this column must be X" without restating every column in the
-- policy, so the fix is the guard-trigger pattern this project already uses
-- for profiles (#23 name guard) and shared_kv (#135 owner lock).
--
-- WHAT IT DOES. For an insert made by a browser role (anon / authenticated —
-- read from BOTH current_user and the JWT role claim, so a security-definer
-- function called from the browser is clamped too), the row is forced to a
-- fresh user submission before any other trigger sees it:
--   status 'pending', source 'user', created_at now(), ai_retry_count 0,
--   and NULL for category, city, every ai_* column, reviewed_by,
--   reviewed_at, review_note, name_clean, description_clean, merged_into,
--   resolved_description, resolved_source.
-- The browser keeps only what the submit form owns: id, name, description,
-- lat, lng, submitted_by (and the policy still requires that to be you).
--
-- CLAMP, NOT REFUSE. index.html's submitGem() already sends
-- status 'pending' and source 'user', so the clamp changes nothing for the
-- real app; a hostile insert lands as an ordinary pending row that the AI
-- gate then reviews like any other.
--
-- WHO IS NOT TOUCHED. service_role (review-submission, the seed/grave/gate
-- tools, delete-account, app-report) and the SQL editor (postgres, no JWT)
-- pass straight through — seeding and operator inserts are unchanged.
--
-- ORDER. Postgres fires same-timing triggers in NAME order.
-- `guard_submission_insert` sorts before `lock_resolved_desc_columns` and
-- `submissions_promote_seed_description`, so both see the clamped row, and
-- the AFTER trigger `submissions_merge_carry_credit` sees merged_into NULL.
--
-- VERIFY. Re-run 477_insert_probe.sql: summary CLOSED, `guard version`
-- reads 477-insert-guard-v1. The last statement below also prints the
-- installed trigger.

create or replace function public.guard_submission_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if current_user in ('anon', 'authenticated')
     or coalesce(auth.role(), '') in ('anon', 'authenticated') then
    new.status               := 'pending';
    new.source               := 'user';
    new.created_at           := now();
    new.ai_retry_count       := 0;
    new.category             := null;
    new.city                 := null;
    new.ai_decision          := null;
    new.ai_reason            := null;
    new.ai_status            := null;
    new.ai_http_status       := null;
    new.ai_model             := null;
    new.ai_confidence        := null;
    new.ai_reviewed_at       := null;
    new.ai_model_source      := null;
    new.reviewed_by          := null;
    new.reviewed_at          := null;
    new.review_note          := null;
    new.name_clean           := null;
    new.description_clean    := null;
    new.merged_into          := null;
    new.resolved_description := null;
    new.resolved_source      := null;
  end if;
  return new;
end;
$function$;

comment on function public.guard_submission_insert() is '477-insert-guard-v1';

-- Trigger functions need no EXECUTE for the inserting role, but match the
-- baseline's posture for server-side trigger functions: no API role may
-- call it directly.
revoke all on function public.guard_submission_insert() from public, anon, authenticated;
grant execute on function public.guard_submission_insert() to service_role;

drop trigger if exists guard_submission_insert on public.submissions;
create trigger guard_submission_insert
  before insert on public.submissions
  for each row execute function public.guard_submission_insert();

select t.tgname as trigger,
       pg_get_triggerdef(t.oid) as definition,
       obj_description('public.guard_submission_insert()'::regprocedure, 'pg_proc') as version
from pg_trigger t
where t.tgrelid = 'public.submissions'::regclass and not t.tgisinternal
order by t.tgname;
