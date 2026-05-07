-- Level Up Fitness user macro targets
-- Adds persisted personalized macro fields to profiles for cloud sync and future analytics.

alter table public.profiles
  add column if not exists tdee integer,
  add column if not exists target_cal integer,
  add column if not exists activity_level text,
  add column if not exists target_protein_g integer,
  add column if not exists target_carb_g integer,
  add column if not exists target_fat_g integer;

comment on column public.profiles.tdee is 'Estimated maintenance calories from Mifflin-St Jeor plus activity multiplier.';
comment on column public.profiles.target_cal is 'Goal-adjusted daily calorie target.';
comment on column public.profiles.target_protein_g is 'Daily protein target in grams.';
comment on column public.profiles.target_carb_g is 'Daily carbohydrate target in grams.';
comment on column public.profiles.target_fat_g is 'Daily fat target in grams.';
