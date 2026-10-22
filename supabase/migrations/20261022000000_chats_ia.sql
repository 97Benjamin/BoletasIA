-- Persistencia de chats del Asistente IA
-- (aplicada live el 21/10/2026: tablas ya existían; se agregaron políticas RLS)

create table if not exists public.chats (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  titulo text not null default 'Nuevo chat',
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create table if not exists public.chat_mensajes (
  id bigint generated always as identity primary key,
  chat_id bigint not null references public.chats(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  rol text not null check (rol in ('user', 'ia')),
  contenido text not null,
  creado_en timestamptz not null default now()
);

create index if not exists idx_chat_mensajes_chat
  on public.chat_mensajes (chat_id, id);
create index if not exists idx_chats_user
  on public.chats (user_id, actualizado_en desc);

alter table public.chats enable row level security;
alter table public.chat_mensajes enable row level security;

drop policy if exists "chats_select" on public.chats;
drop policy if exists "chats_insert" on public.chats;
drop policy if exists "chats_update" on public.chats;
drop policy if exists "chats_delete" on public.chats;
drop policy if exists "mensajes_select" on public.chat_mensajes;
drop policy if exists "mensajes_insert" on public.chat_mensajes;
drop policy if exists "mensajes_delete" on public.chat_mensajes;

create policy "chats_select" on public.chats
  for select to authenticated using (user_id = auth.uid());
create policy "chats_insert" on public.chats
  for insert to authenticated with check (user_id = auth.uid());
create policy "chats_update" on public.chats
  for update to authenticated using (user_id = auth.uid());
create policy "chats_delete" on public.chats
  for delete to authenticated using (user_id = auth.uid());

create policy "mensajes_select" on public.chat_mensajes
  for select to authenticated using (user_id = auth.uid());
create policy "mensajes_insert" on public.chat_mensajes
  for insert to authenticated with check (user_id = auth.uid());
create policy "mensajes_delete" on public.chat_mensajes
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.chats to authenticated;
grant select, insert, delete on public.chat_mensajes to authenticated;
