# Supabase Security Advisor Fix Checklist

Use this checklist after running `supabase/security-hardening.sql`.

## 1) Run SQL hardening script

- Open Supabase SQL Editor.
- Run `supabase/security-hardening.sql`.
- Re-open Security Advisor and confirm critical items are gone.

## 2) Dashboard-only settings (not SQL)

Some alerts cannot be fixed from your app code/migrations:

- **Leaked Password Protection Disabled**
  - Supabase Dashboard -> Authentication -> Providers -> Email
  - Enable leaked password protection.

## 3) RLS policy review

If you still see warnings like "Multiple Permissive Policies", keep only the minimum policies needed.

Practical approach:

1. Open the table in Security Advisor message.
2. Compare all policies for that table.
3. Remove overlapping permissive policies when one policy already covers the same access.

## 4) Performance warnings (Auth RLS Initialization Plan)

These are performance hints, not direct data leaks. Tuning options:

- Ensure indexes exist on columns used in policies (`user_id`, `project_id`, etc.).
- Keep policy predicates simple.
- Prefer direct comparisons (`user_id = auth.uid()`) over large nested subqueries where possible.
