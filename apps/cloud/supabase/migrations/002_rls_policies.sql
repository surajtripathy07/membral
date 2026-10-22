-- Enable RLS
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.extracted_metadata enable row level security;

-- Profiles: users can only access their own profile
create policy "Users can view own profile" on public.profiles
  for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles
  for update using (auth.uid() = id);

-- Conversations: users can only access their own conversations
create policy "Users can view own conversations" on public.conversations
  for select using (auth.uid() = user_id);
create policy "Users can insert own conversations" on public.conversations
  for insert with check (auth.uid() = user_id);
create policy "Users can update own conversations" on public.conversations
  for update using (auth.uid() = user_id);
create policy "Users can delete own conversations" on public.conversations
  for delete using (auth.uid() = user_id);

-- Extracted metadata: accessible via conversation ownership
create policy "Users can view own metadata" on public.extracted_metadata
  for select using (
    exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
  );
