-- Cookbook entitlement + community recipe pool
-- Run order: after profiles + ai_usage tables exist.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. cookbook_unlocks — per-user, per-cookbook entitlement
-- One row = "this user has paid for / been granted access to this cookbook".
-- Tasty Shreds is cookbook_id='tastyshreds'. User-uploaded books get a generated id.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.cookbook_unlocks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  cookbook_id   text not null,
  cookbook_name text,
  unlocked_at   timestamptz not null default now(),
  source        text default 'purchase',  -- 'purchase' | 'upload' | 'admin_grant' | 'gift'
  recipe_count  integer default 0,
  unique (user_id, cookbook_id)
);

create index if not exists cookbook_unlocks_user_idx
  on public.cookbook_unlocks (user_id);

alter table public.cookbook_unlocks enable row level security;

drop policy if exists "users read own unlocks" on public.cookbook_unlocks;
create policy "users read own unlocks"
  on public.cookbook_unlocks for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own unlocks" on public.cookbook_unlocks;
create policy "users insert own unlocks"
  on public.cookbook_unlocks for insert
  with check (auth.uid() = user_id);

-- No update / delete from client — admin only via service role.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. community_recipes — anonymized recipe pool for cross-user learning
-- When a user imports a cookbook, each recipe also lands here (without
-- copyrighted name + source) so the suggestion engine can learn from all imports.
-- Critical: NO user_id stored here. NO original source name. NO original name.
-- Only macro shape, ingredient list, normalized category, and a hash for dedup.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.community_recipes (
  id              uuid primary key default gen_random_uuid(),
  recipe_hash     text not null unique,                  -- sha256(normalized ingredients) for dedup
  category        text,                                  -- breakfast / lunch / dinner / snack / shake
  calories        integer,
  protein_g       integer,
  carbs_g         integer,
  fat_g           integer,
  ingredient_tags text[],                                -- normalized: ["chicken","rice","cheese"]
  base_servings   integer default 1,
  popularity      integer default 1,                     -- incremented on duplicate import
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now()
);

create index if not exists community_recipes_macro_idx
  on public.community_recipes (calories, protein_g);

create index if not exists community_recipes_tags_gin
  on public.community_recipes using gin (ingredient_tags);

alter table public.community_recipes enable row level security;

-- Anyone authed can read the pool (it's anonymized).
drop policy if exists "any authed user can read community pool" on public.community_recipes;
create policy "any authed user can read community pool"
  on public.community_recipes for select
  using (auth.role() = 'authenticated');

-- Inserts go through an RPC (so we can dedup + bump popularity server-side).
-- Direct insert from client allowed but no overwrite.
drop policy if exists "any authed user can insert community recipe" on public.community_recipes;
create policy "any authed user can insert community recipe"
  on public.community_recipes for insert
  with check (auth.role() = 'authenticated');

-- Server-side upsert helper that bumps popularity if hash already exists.
create or replace function public.upsert_community_recipe(
  p_recipe_hash text,
  p_category text,
  p_calories integer,
  p_protein integer,
  p_carbs integer,
  p_fat integer,
  p_tags text[],
  p_servings integer
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id uuid;
begin
  select id into existing_id from public.community_recipes where recipe_hash = p_recipe_hash;
  if existing_id is not null then
    update public.community_recipes
       set popularity = popularity + 1,
           last_seen  = now()
     where id = existing_id;
    return existing_id;
  end if;

  insert into public.community_recipes (
    recipe_hash, category, calories, protein_g, carbs_g, fat_g,
    ingredient_tags, base_servings
  ) values (
    p_recipe_hash, p_category, p_calories, p_protein, p_carbs, p_fat,
    coalesce(p_tags, '{}'), coalesce(p_servings, 1)
  )
  returning id into existing_id;

  return existing_id;
end;
$$;

grant execute on function public.upsert_community_recipe(text, text, integer, integer, integer, integer, text[], integer)
  to authenticated;
