-- ============================================================
--  ОХВАТ — схема базы для Supabase
--  Вставьте целиком в SQL Editor и нажмите Run.
--  Повторный запуск безопасен: всё создаётся с if not exists.
-- ============================================================

-- ---------- 1. ГОРОДА (справочник для карты и поиска) --------
create table if not exists public.cities (
  id          bigint generated always as identity primary key,
  key         text unique not null,          -- "New York" — совпадает с ключом в коде
  name_ru     text not null,                 -- "Нью-Йорк"
  country     text not null default 'США',
  lat         double precision not null,
  lng         double precision not null,
  status      text not null default 'live'   -- live | soon
              check (status in ('live','soon')),
  reach       text,                          -- "8.4 млн" — просто подпись
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- 2. МАСТЕРА (кто занимает зону) -------------------
create table if not exists public.masters (
  id            bigint generated always as identity primary key,
  name          text not null,
  service       text not null,               -- barber | tattoo | nails | ...
  city_key      text references public.cities(key),

  -- зона эксклюзива
  lat           double precision not null,
  lng           double precision not null,
  radius_mi     numeric not null default 15, -- радиус в милях

  -- точный адрес НЕ показывается публично, только для вас
  address_exact text,
  phone         text,
  email         text,

  -- профиль
  quote         text,
  bio           text,
  tags          text[] default '{}',
  links         jsonb  default '[]',         -- [{"t":"instagram.com/x","u":"https://..."}]
  photo_url     text,
  since_year    int,
  works         int    default 0,
  rating        numeric(2,1),

  -- срок слота
  active        boolean not null default true,
  slot_until    date,                        -- когда зона освободится
  created_at    timestamptz not null default now()
);

create index if not exists masters_service_idx on public.masters (service) where active;
create index if not exists masters_geo_idx     on public.masters (lat, lng)  where active;

-- ---------- 3. ЗАЯВКИ ----------------------------------------
create table if not exists public.leads (
  id          bigint generated always as identity primary key,
  ticket      text unique,
  name        text not null,
  city        text,
  service     text,
  experience  text,
  link        text,
  email       text not null,
  contact     text,
  about       text,
  plan        text,                          -- basic | promo
  lat         double precision,              -- координаты адреса из заявки
  lng         double precision,
  status      text not null default 'new'
              check (status in ('new','contacted','negotiating','signed','rejected')),
  notes       text,                          -- ваши пометки после звонка
  master_id   bigint references public.masters(id),  -- если заявка стала мастером
  created_at  timestamptz not null default now()
);

create index if not exists leads_status_idx on public.leads (status, created_at desc);

-- ============================================================
--  ДОСТУПЫ. Сайт статический, ключ виден в коде — поэтому
--  наружу отдаём минимум: публичную витрину мастеров и
--  право положить заявку. Читать заявки может только вы,
--  через панель Supabase.
-- ============================================================

alter table public.cities  enable row level security;
alter table public.masters enable row level security;
alter table public.leads   enable row level security;

-- города читают все
drop policy if exists cities_read on public.cities;
create policy cities_read on public.cities
  for select to anon, authenticated using (active);

-- витрина мастеров: без адреса, телефона и почты
create or replace view public.masters_public as
  select id, name, service, city_key, lat, lng, radius_mi,
         quote, bio, tags, links, photo_url, since_year, works, rating, slot_until
  from public.masters
  where active;

revoke all on public.masters from anon, authenticated;
grant select on public.masters_public to anon, authenticated;

-- заявки: можно только вставить, читать нельзя
drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert to anon, authenticated with check (true);

revoke select, update, delete on public.leads from anon, authenticated;
grant insert on public.leads to anon, authenticated;

-- ============================================================
--  ПРОВЕРКА ЗАНЯТОСТИ (необязательно, но удобно)
--  select * from slot_taken(40.7128, -74.0060, 'barber');
-- ============================================================
create or replace function public.slot_taken(
  p_lat double precision, p_lng double precision, p_service text
) returns table (master_id bigint, master_name text, distance_mi numeric)
language sql stable security definer set search_path = public as $$
  select m.id, m.name,
         round((3958.8 * 2 * asin(sqrt(
           power(sin(radians(m.lat - p_lat)/2), 2) +
           cos(radians(p_lat)) * cos(radians(m.lat)) *
           power(sin(radians(m.lng - p_lng)/2), 2)
         )))::numeric, 1) as distance_mi
  from public.masters m
  where m.active
    and m.service = p_service
    and (m.slot_until is null or m.slot_until >= current_date)
    and 3958.8 * 2 * asin(sqrt(
          power(sin(radians(m.lat - p_lat)/2), 2) +
          cos(radians(p_lat)) * cos(radians(m.lat)) *
          power(sin(radians(m.lng - p_lng)/2), 2)
        )) <= m.radius_mi
  order by distance_mi
  limit 1;
$$;

grant execute on function public.slot_taken to anon, authenticated;

-- ============================================================
--  ПЕРЕВОД ЗАЯВКИ В МАСТЕРА — вызывать после подписания
--  select approve_lead(12, 40.7128, -74.0060, 15);
-- ============================================================
create or replace function public.approve_lead(
  p_lead_id bigint, p_lat double precision, p_lng double precision, p_radius numeric default 15
) returns bigint language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  insert into public.masters (name, service, lat, lng, radius_mi, email)
  select l.name, l.service, p_lat, p_lng, p_radius, l.email
  from public.leads l where l.id = p_lead_id
  returning id into new_id;

  update public.leads
     set status = 'signed', master_id = new_id
   where id = p_lead_id;

  return new_id;
end $$;

revoke execute on function public.approve_lead from anon, authenticated;
