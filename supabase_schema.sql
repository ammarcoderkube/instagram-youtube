-- =========================================================================
-- Supabase Schema for Linkly (Instagram & YouTube Downloader)
-- =========================================================================

-- 1. Create user_sessions table
create table if not exists public.user_sessions (
    id uuid primary key default gen_random_uuid(),
    device_id text not null,
    sessionid text not null,
    username text default 'Connected User',
    ds_user_id text,
    is_device_linked boolean default true,
    is_active boolean default true,
    last_active_at timestamptz default timezone('utc'::text, now()),
    created_at timestamptz default timezone('utc'::text, now())
);

-- Indexing for quick lookups by device and session
create index if not exists idx_user_sessions_device_id on public.user_sessions(device_id);
create index if not exists idx_user_sessions_sessionid on public.user_sessions(sessionid);
create index if not exists idx_user_sessions_is_active on public.user_sessions(is_active);

-- 2. Create download_history table
create table if not exists public.download_history (
    id uuid primary key default gen_random_uuid(),
    device_id text,
    url text not null,
    title text,
    media_type text default 'video',
    format text default 'MP4',
    quality text default '1080p',
    filename text not null,
    file_size bigint default 0,
    owner text,
    caption text,
    download_url text not null,
    preview_url text,
    account_used text,
    created_at timestamptz default timezone('utc'::text, now())
);

-- Indexing for user history retrieval
create index if not exists idx_download_history_device_id on public.download_history(device_id);
create index if not exists idx_download_history_created_at on public.download_history(created_at desc);

-- 3. Enable Row Level Security (RLS)
alter table public.user_sessions enable row level security;
alter table public.download_history enable row level security;

-- Permissive policies for anon and service_role access
create policy "Allow all operations for anon and service_role on user_sessions"
    on public.user_sessions
    for all
    using (true)
    with check (true);

create policy "Allow all operations for anon and service_role on download_history"
    on public.download_history
    for all
    using (true)
    with check (true);
