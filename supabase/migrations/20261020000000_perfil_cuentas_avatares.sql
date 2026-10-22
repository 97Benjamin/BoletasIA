-- Edición de nombre (perfiles) y gestión de cuentas (cuentas) desde la app,
-- más el bucket público "avatars" para la foto de perfil.

alter table public.perfiles enable row level security;

drop policy if exists "Users can update own perfil"
  on public.perfiles;
create policy "Users can update own perfil"
  on public.perfiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter table public.cuentas enable row level security;

-- Las cuentas se crean solo con nombre; el tipo queda libre.
alter table public.cuentas alter column tipo drop not null;

drop policy if exists "Users can insert own cuentas"
  on public.cuentas;
create policy "Users can insert own cuentas"
  on public.cuentas
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can update own cuentas"
  on public.cuentas;
create policy "Users can update own cuentas"
  on public.cuentas
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete own cuentas"
  on public.cuentas;
create policy "Users can delete own cuentas"
  on public.cuentas
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- Bucket público para avatares (cada usuario solo escribe en su carpeta).
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update
  set public = true;

drop policy if exists "Users can upload own avatar"
  on storage.objects;
create policy "Users can upload own avatar"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can replace own avatar"
  on storage.objects;
create policy "Users can replace own avatar"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Public can read avatars"
  on storage.objects;
create policy "Public can read avatars"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'avatars');

drop policy if exists "Users can read own avatar"
  on storage.objects;
create policy "Users can read own avatar"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete own avatar"
  on storage.objects;
create policy "Users can delete own avatar"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
