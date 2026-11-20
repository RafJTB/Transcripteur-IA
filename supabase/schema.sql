-- =====================================================================
-- Transcripteur IA : espaces collaboratifs (Supabase)
-- À coller une fois dans Supabase → SQL Editor → New query → Run.
-- Ré-exécutable sans danger (crée seulement ce qui manque, remplace les règles).
-- =====================================================================

-- Espaces
create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

-- Membres (par adresse e-mail : une personne invitée voit l'espace dès sa première connexion)
create table if not exists public.space_members (
  space_id uuid not null references public.spaces on delete cascade,
  email text not null check (email = lower(email)),
  role text not null default 'member' check (role in ('owner', 'member')),
  added_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (space_id, email)
);

-- Transcriptions partagées (le texte complet, et le chemin de l'audio compressé s'il y en a un)
create table if not exists public.space_docs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces on delete cascade,
  title text not null,
  doc jsonb not null,
  duration_s real,
  audio_path text,
  audio_bytes integer,
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  author_name text,
  author_email text,
  created_at timestamptz not null default now()
);
create index if not exists space_docs_space on public.space_docs (space_id, created_at desc);

-- Conversation de l'espace (messages entre membres, en direct)
create table if not exists public.space_messages (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces on delete cascade,
  author uuid not null default auth.uid() references auth.users on delete cascade,
  author_name text,
  author_email text,
  body text not null check (char_length(body) between 1 and 4000),
  doc_id uuid references public.space_docs on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists space_messages_space on public.space_messages (space_id, created_at desc);

-- Adresse e-mail de la personne connectée (en minuscules)
create or replace function public.my_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

-- Est-ce que je suis membre de cet espace ? (security definer : évite la récursion des règles)
create or replace function public.is_member(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.space_members m where m.space_id = s and m.email = public.my_email())
$$;

create or replace function public.is_owner(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.spaces x where x.id = s and x.owner = auth.uid())
$$;

-- Le créateur d'un espace en devient automatiquement membre (propriétaire)
create or replace function public.add_owner_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.space_members (space_id, email, role, added_by)
  values (new.id, public.my_email(), 'owner', new.owner)
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists spaces_add_owner on public.spaces;
create trigger spaces_add_owner after insert on public.spaces for each row execute function public.add_owner_member();

-- Droits d'accès des utilisateurs connectés (les projets Supabase récents ne les donnent plus d'office
-- aux tables créées par script). Les règles ci-dessous (RLS) restent le vrai contrôle.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.spaces, public.space_members, public.space_docs, public.space_messages to authenticated;
grant execute on function public.my_email(), public.is_member(uuid), public.is_owner(uuid) to authenticated;

-- Règles d'accès (Row Level Security)
alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.space_docs enable row level security;
alter table public.space_messages enable row level security;

drop policy if exists "espaces : lecture membres" on public.spaces;
create policy "espaces : lecture membres" on public.spaces for select using (public.is_member(id) or owner = auth.uid());
drop policy if exists "espaces : création" on public.spaces;
create policy "espaces : création" on public.spaces for insert with check (owner = auth.uid() and public.my_email() <> '');
drop policy if exists "espaces : propriétaire modifie" on public.spaces;
create policy "espaces : propriétaire modifie" on public.spaces for update using (owner = auth.uid());
drop policy if exists "espaces : propriétaire supprime" on public.spaces;
create policy "espaces : propriétaire supprime" on public.spaces for delete using (owner = auth.uid());

drop policy if exists "membres : lecture" on public.space_members;
create policy "membres : lecture" on public.space_members for select using (public.is_member(space_id));
drop policy if exists "membres : le propriétaire invite" on public.space_members;
create policy "membres : le propriétaire invite" on public.space_members for insert with check (public.is_owner(space_id) and role = 'member');
drop policy if exists "membres : retrait" on public.space_members;
create policy "membres : retrait" on public.space_members for delete
  using ((public.is_owner(space_id) and role = 'member') or (email = public.my_email() and role = 'member'));

drop policy if exists "transcriptions : lecture membres" on public.space_docs;
create policy "transcriptions : lecture membres" on public.space_docs for select using (public.is_member(space_id));
drop policy if exists "transcriptions : ajout membres" on public.space_docs;
create policy "transcriptions : ajout membres" on public.space_docs for insert with check (public.is_member(space_id) and created_by = auth.uid());
drop policy if exists "transcriptions : auteur ou propriétaire supprime" on public.space_docs;
create policy "transcriptions : auteur ou propriétaire supprime" on public.space_docs for delete using (created_by = auth.uid() or public.is_owner(space_id));

drop policy if exists "messages : lecture membres" on public.space_messages;
create policy "messages : lecture membres" on public.space_messages for select using (public.is_member(space_id));
drop policy if exists "messages : envoi membres" on public.space_messages;
create policy "messages : envoi membres" on public.space_messages for insert with check (public.is_member(space_id) and author = auth.uid());
drop policy if exists "messages : auteur ou propriétaire supprime" on public.space_messages;
create policy "messages : auteur ou propriétaire supprime" on public.space_messages for delete using (author = auth.uid() or public.is_owner(space_id));

-- Messages en direct (Realtime) : la table est ajoutée à la publication de Supabase si besoin
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'space_messages') then
    alter publication supabase_realtime add table public.space_messages;
  end if;
end $$;

-- Audio : seau privé « space-audio », un dossier par espace (space-audio/<id de l'espace>/…)
insert into storage.buckets (id, name, public, file_size_limit)
values ('space-audio', 'space-audio', false, 50 * 1024 * 1024)
on conflict (id) do nothing;

drop policy if exists "audio : lecture membres" on storage.objects;
create policy "audio : lecture membres" on storage.objects for select
  using (bucket_id = 'space-audio' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "audio : envoi membres" on storage.objects;
create policy "audio : envoi membres" on storage.objects for insert
  with check (bucket_id = 'space-audio' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "audio : suppression auteur ou propriétaire" on storage.objects;
create policy "audio : suppression auteur ou propriétaire" on storage.objects for delete
  using (bucket_id = 'space-audio' and (owner = auth.uid() or public.is_owner(((storage.foldername(name))[1])::uuid)));
