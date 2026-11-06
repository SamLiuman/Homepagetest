-- =============================================================================
--  学业答疑 · Supabase 建库脚本
--  ---------------------------------------------------------------------------
--  用法：
--    1. 打开 https://supabase.com 注册一个免费项目（无需信用卡）
--    2. 左侧菜单 → SQL Editor → New query → 把本文件整段粘进去 → Run
--    3. 左侧菜单 → Project Settings → API，复制两个值：
--         · Project URL           → 填到 qa.html 的 QA_CONFIG.supabaseUrl
--         · anon public (API Key) → 填到 qa.html 的 QA_CONFIG.supabaseAnonKey
--    4. 把 qa.html 里的 backend 改成 'supabase'
--
--  权限设计（这就是"删除只有站主一人"的保证）：
--    · anon（访客）→ 只能 SELECT 和 INSERT。没有任何 UPDATE / DELETE 策略，
--                    所以拿着 anon key 也删不掉任何一行，前端改代码也没用。
--    · 删除        → 只能通过下面的 qa_delete_question / qa_delete_answer，
--                    这两个函数在服务端比对口令，口令存在一张对外完全不可见
--                    的表里（RLS 开启且无任何策略 = 谁都读不到）。
--    · 口令明文不会出现在任何前端文件里。
-- =============================================================================

create extension if not exists pgcrypto;


-- ============================ 1. 数据表 ============================

create table if not exists public.qa_questions (
    id          uuid        primary key default gen_random_uuid(),
    content     text        not null check (char_length(content) between 1 and 2000),
    author      text        not null default '匿名同学' check (char_length(author) <= 20),
    images      text[]      not null default '{}',
    created_at  timestamptz not null default now()
);

create table if not exists public.qa_answers (
    id          uuid        primary key default gen_random_uuid(),
    question_id uuid        not null references public.qa_questions(id) on delete cascade,
    content     text        not null check (char_length(content) between 1 and 2000),
    author      text        not null default '匿名同学' check (char_length(author) <= 20),
    images      text[]      not null default '{}',
    created_at  timestamptz not null default now()
);

-- 已经建过表的老版本，补上 images 列（重复执行无副作用）
alter table public.qa_questions add column if not exists images text[] not null default '{}';
alter table public.qa_answers   add column if not exists images text[] not null default '{}';

create index if not exists qa_answers_question_id_idx
    on public.qa_answers (question_id);

create index if not exists qa_questions_created_at_idx
    on public.qa_questions (created_at desc);


-- ============================ 2. 站长口令表 ============================
-- 这张表对外完全不可见：开了 RLS 却不给任何策略，anon / authenticated 都读不到。
-- 只有下面的 security definer 函数（以表所有者身份运行）能读取。

create table if not exists public.qa_admin_secret (
    pass text not null
);

-- >>>>>>>>>> 把下面这行引号里的内容改成只有你知道的口令 <<<<<<<<<<
-- 只在表为空时插入，重复执行本脚本不会覆盖你已经改过的口令。
insert into public.qa_admin_secret (pass)
select 'iron-qa-CHANGE-ME-2026'
where not exists (select 1 from public.qa_admin_secret);


-- ============================ 3. 行级权限 ============================

alter table public.qa_questions    enable row level security;
alter table public.qa_answers      enable row level security;
alter table public.qa_admin_secret enable row level security;

-- --- 问题：任何人可读 ---
drop policy if exists qa_q_read on public.qa_questions;
create policy qa_q_read on public.qa_questions
    for select using (true);

-- --- 问题：任何人可写（匿名，免登录）---
drop policy if exists qa_q_insert on public.qa_questions;
create policy qa_q_insert on public.qa_questions
    for insert with check (true);

-- --- 回答：任何人可读 ---
drop policy if exists qa_a_read on public.qa_answers;
create policy qa_a_read on public.qa_answers
    for select using (true);

-- --- 回答：任何人可写（匿名，免登录）---
drop policy if exists qa_a_insert on public.qa_answers;
create policy qa_a_insert on public.qa_answers
    for insert with check (true);

-- 刻意不建任何 UPDATE / DELETE 策略：
-- anon key 直接删表 → 会被数据库拒绝（返回 0 行受影响），这是权限层面的硬保证。


-- ============================ 4. 站长删除函数 ============================

-- 删除提问（级联删除其下所有回答）
create or replace function public.qa_delete_question(target uuid, p_pass text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    ok boolean := false;
begin
    select (s.pass = p_pass) into ok
    from public.qa_admin_secret s
    limit 1;

    if ok is not true then
        return false;
    end if;

    delete from public.qa_questions where id = target;
    return true;
end;
$$;

-- 删除单条回答
create or replace function public.qa_delete_answer(target uuid, p_pass text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    ok boolean := false;
begin
    select (s.pass = p_pass) into ok
    from public.qa_admin_secret s
    limit 1;

    if ok is not true then
        return false;
    end if;

    delete from public.qa_answers where id = target;
    return true;
end;
$$;

revoke all on function public.qa_delete_question(uuid, text) from public;
revoke all on function public.qa_delete_answer(uuid, text)   from public;

grant execute on function public.qa_delete_question(uuid, text) to anon, authenticated;
grant execute on function public.qa_delete_answer(uuid, text)   to anon, authenticated;


-- ============================ 5. 图片存储（Storage）============================
-- 题目多是拍照上传，图片放在公开桶里，前端只拿到 URL。
-- 策略与数据表一致：谁都能上传、谁都能看，但【谁都不能删】。
-- 删除提问时图片不会自动消失（会变成孤儿文件），需要时用本文件末尾的清理语句。

insert into storage.buckets (id, name, public)
values ('qa-images', 'qa-images', true)
on conflict (id) do nothing;

-- 单张上限 3MB（前端会先压到 200KB 左右，这里只是兜底）
update storage.buckets
set file_size_limit = 3145728,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'qa-images';

-- 任何人可读
drop policy if exists qa_img_read on storage.objects;
create policy qa_img_read on storage.objects
    for select using (bucket_id = 'qa-images');

-- 任何人可上传（匿名，免登录）
drop policy if exists qa_img_insert on storage.objects;
create policy qa_img_insert on storage.objects
    for insert with check (bucket_id = 'qa-images');

-- 同样刻意不建 update / delete 策略：访客删不掉任何图片。


-- =============================================================================
--  改口令的方法（想换口令时执行这一句）：
--     update public.qa_admin_secret set pass = '新的口令';
--
--  想彻底关闭删除入口（比如考试周）：
--     revoke execute on function public.qa_delete_question(uuid, text) from anon;
--  恢复：
--     grant execute on function public.qa_delete_question(uuid, text) to anon;
--
--  每天清理超过 200 天的旧帖（可选，在 SQL Editor 里手动跑）：
--     delete from public.qa_questions where created_at < now() - interval '200 days';
--
--  清理没人引用的孤儿图片（删过提问后跑一次）：
--     delete from storage.objects o
--     where o.bucket_id = 'qa-images'
--       and not exists (
--         select 1 from public.qa_questions q
--         where o.name = any (
--             select regexp_replace(u, '^.*/qa-images/', '')
--             from unnest(q.images) u
--         )
--       )
--       and not exists (
--         select 1 from public.qa_answers a
--         where o.name = any (
--             select regexp_replace(u, '^.*/qa-images/', '')
--             from unnest(a.images) u
--         )
--       );
-- =============================================================================
