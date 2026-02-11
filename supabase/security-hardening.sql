-- Security hardening for Supabase Security Advisor findings
-- Safe to run multiple times (idempotent where possible).

begin;

-- 1) Ensure RLS is enabled for tables flagged as critical.
alter table if exists public.schedule_settings enable row level security;
alter table if exists public.subscriptions enable row level security;

-- 2) Add baseline policies for tables that often miss policies.
--    Adjust these rules to match your business rules if needed.
do $$
begin
  if to_regclass('public.schedule_settings') is not null then
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'schedule_settings'
        and policyname = 'Users manage own schedule settings'
    ) then
      create policy "Users manage own schedule settings"
      on public.schedule_settings
      for all
      using (
        exists (
          select 1
          from public.projects p
          where p.id = schedule_settings.project_id
            and p.owner_id = auth.uid()
        )
        or public.is_gestor()
      )
      with check (
        exists (
          select 1
          from public.projects p
          where p.id = schedule_settings.project_id
            and p.owner_id = auth.uid()
        )
        or public.is_gestor()
      );
    end if;
  end if;

  if to_regclass('public.subscriptions') is not null then
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'subscriptions'
        and policyname = 'Users manage own subscriptions'
    ) then
      create policy "Users manage own subscriptions"
      on public.subscriptions
      for all
      using (
        user_id = auth.uid()
        or public.is_gestor()
      )
      with check (
        user_id = auth.uid()
        or public.is_gestor()
      );
    end if;
  end if;
end $$;

-- 3) Lock down search_path for Security Advisor "Function Search Path Mutable" warnings.
--    Only apply if function exists.
do $$
begin
  if to_regprocedure('public.is_gestor()') is not null then
    alter function public.is_gestor() set search_path = public, pg_temp;
  end if;

  if to_regprocedure('public.handle_new_user_create_project()') is not null then
    alter function public.handle_new_user_create_project() set search_path = public, pg_temp;
  end if;

  if to_regprocedure('public.set_updated_at_google_oauth_tokens()') is not null then
    alter function public.set_updated_at_google_oauth_tokens() set search_path = public, pg_temp;
  end if;

  if to_regprocedure('public.handle_new_user()') is not null then
    alter function public.handle_new_user() set search_path = public, pg_temp;
  end if;
end $$;

commit;
