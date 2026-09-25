-- 410_close_cleanup_view.sql — #410: close public.submission_cleanup_review.
-- Found by #409's schema export, 2026-09-24. Run ONCE in: Supabase dashboard →
-- SQL Editor → paste this whole file → Run. Safe to run twice.
--
-- THE HOLE. Item 12 (2026-07-22) created this operator-only diff view, and
-- Supabase's default grants gave anon + authenticated every privilege on it.
-- A plain view runs as its OWNER, so it skips submissions' RLS and its
-- column grants, and a one-table view is auto-updatable. Confirmed live with
-- only the public key, no login:
--   read:  all 5,955 submissions, incl. 346 rejected, with raw name + text
--   write: a zero-row PATCH through the view returned 200, not "permission
--          denied" — so anyone could change status / category / name /
--          description on ANY submission, or delete rows, through it.
-- Nothing in the app, the functions or the tools uses the view; the operator
-- reads it in the SQL editor as postgres, which this does not touch.
--
-- THE FIX, two layers:
--   1. revoke every privilege from anon + authenticated (closes it now);
--   2. security_invoker = true, so even a future accidental grant runs as
--      the caller and hits submissions' RLS + column grants instead of
--      the owner's bypass.

begin;

revoke all on table public.submission_cleanup_review from public, anon, authenticated;
alter view public.submission_cleanup_review set (security_invoker = true);

commit;

-- CHECK (the editor shows only this last result). Expect every can_* false and
-- invoker true. The counts are for comparing against what you expect — there
-- is no audit trail for writes made through the view.
select has_table_privilege('anon',          'public.submission_cleanup_review', 'select') as anon_can_read,
       has_table_privilege('anon',          'public.submission_cleanup_review', 'update') as anon_can_update,
       has_table_privilege('anon',          'public.submission_cleanup_review', 'delete') as anon_can_delete,
       has_table_privilege('authenticated', 'public.submission_cleanup_review', 'update') as authed_can_update,
       coalesce((select 'security_invoker=true' = any (c.reloptions)
                   from pg_class c where c.oid = 'public.submission_cleanup_review'::regclass), false) as invoker,
       (select count(*) from public.submissions where status = 'approved') as approved,
       (select count(*) from public.submissions where status = 'pending')  as pending,
       (select count(*) from public.submissions where status = 'rejected') as rejected;
