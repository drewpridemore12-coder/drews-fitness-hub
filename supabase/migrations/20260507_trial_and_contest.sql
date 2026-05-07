-- 30-day trial tracking + monthly feedback contest
-- Run after profiles + feedback tables exist.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. profiles.trial_started_at + trial_plan
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_plan       text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. contest_entries — one row per feedback submission
-- Used for monthly drawing of 3 free months of Elite plan.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.contest_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  entry_source  text not null,            -- 'feedback' | 'referral' | 'social_post' | 'admin_grant'
  created_at    timestamptz not null default now(),
  drawn_for     date,                     -- set when this entry was used in a drawing (YYYY-MM-01)
  is_winner     boolean default false,
  metadata      jsonb
);

create index if not exists contest_entries_user_idx
  on public.contest_entries (user_id);

create index if not exists contest_entries_drawn_idx
  on public.contest_entries (drawn_for) where drawn_for is null;

alter table public.contest_entries enable row level security;

drop policy if exists "users read own contest entries" on public.contest_entries;
create policy "users read own contest entries"
  on public.contest_entries for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own contest entries" on public.contest_entries;
create policy "users insert own contest entries"
  on public.contest_entries for insert
  with check (auth.uid() = user_id);

-- Admin-only update (winner picking) — handled via service role from a scheduled function.
-- No client update / delete policy.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Monthly drawing function — picks one random un-drawn entry as winner.
-- Manual trigger: select pick_monthly_contest_winner();
-- Returns the winning user's id and entry id.
-- Grant 3 months Elite by inserting into a separate `plan_grants` table or
-- directly updating profiles.plan + trial_started_at to (now - 0) + flag.
-- For now this is a manual admin action — function returns the winner so
-- admin can grant the prize.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.pick_monthly_contest_winner(
  p_month date default date_trunc('month', current_date)::date
) returns table (winner_user_id uuid, winning_entry_id uuid, total_entries bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_winner_id uuid;
  v_entry_id  uuid;
  v_total     bigint;
begin
  select count(*) into v_total
  from public.contest_entries
  where drawn_for is null
    and created_at >= p_month
    and created_at <  (p_month + interval '1 month');

  select id, user_id into v_entry_id, v_winner_id
  from public.contest_entries
  where drawn_for is null
    and created_at >= p_month
    and created_at <  (p_month + interval '1 month')
  order by random()
  limit 1;

  if v_entry_id is not null then
    update public.contest_entries
       set drawn_for = p_month, is_winner = true
     where id = v_entry_id;

    update public.contest_entries
       set drawn_for = p_month
     where drawn_for is null
       and created_at >= p_month
       and created_at <  (p_month + interval '1 month');
  end if;

  return query select v_winner_id, v_entry_id, v_total;
end;
$$;

revoke all on function public.pick_monthly_contest_winner(date) from public, authenticated;
-- Only callable from service-role / SQL editor.
