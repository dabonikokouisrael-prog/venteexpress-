-- VenteExpress — schéma Supabase (PRÊT MAIS PAS ENCORE BRANCHÉ À L'APP)
-- À exécuter dans Supabase > SQL Editor. Non testé sur un vrai projet Supabase.

create table public.vendors (
  id uuid primary key references auth.users(id) on delete cascade,
  shop_name text not null check (char_length(shop_name) between 1 and 60),
  whatsapp text check (whatsapp ~ '^[0-9]{6,16}$'),
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text check (char_length(description) <= 600),
  price numeric not null check (price >= 0),
  currency text not null default 'FCFA',
  cost numeric check (cost >= 0),            -- PRIVÉ : prix d'achat
  stock integer check (stock >= 0),          -- PRIVÉ : quantité exacte (null = non suivi)
  photo_path text,                           -- chemin dans Storage (bucket product-media)
  video_path text,
  created_at timestamptz not null default now()
);

create table public.catalogs (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.catalog_products (
  catalog_id uuid not null references public.catalogs(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  primary key (catalog_id, product_id)
);

alter table public.vendors enable row level security;
alter table public.products enable row level security;
alter table public.catalogs enable row level security;
alter table public.catalog_products enable row level security;

-- Chaque vendeur ne voit et ne modifie que ses propres lignes
create policy "vendor own row" on public.vendors for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy "vendor own products" on public.products for all to authenticated
  using (vendor_id = auth.uid()) with check (vendor_id = auth.uid());
create policy "vendor own catalogs" on public.catalogs for all to authenticated
  using (vendor_id = auth.uid()) with check (vendor_id = auth.uid());
create policy "vendor own catalog_products" on public.catalog_products for all to authenticated
  using (exists (select 1 from public.catalogs c where c.id = catalog_id and c.vendor_id = auth.uid()))
  with check (exists (select 1 from public.catalogs c where c.id = catalog_id and c.vendor_id = auth.uid())
              and exists (select 1 from public.products p where p.id = product_id and p.vendor_id = auth.uid()));

-- Lecture publique SANS exposer cost/stock : le public passe par cette fonction, jamais par les tables
create or replace function public.get_public_catalog(p_slug text)
returns jsonb language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'shop', v.shop_name, 'phone', v.whatsapp,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'desc', p.description, 'price', p.price, 'cur', p.currency,
        'photo', p.photo_path, 'video', p.video_path,
        'available', (p.stock is null or p.stock > 0)) order by p.created_at desc)
      from catalog_products cp join products p on p.id = cp.product_id
      where cp.catalog_id = c.id), '[]'::jsonb))
  from catalogs c join vendors v on v.id = c.vendor_id
  where c.slug = p_slug and c.is_public
$$;
revoke all on function public.get_public_catalog(text) from public;
grant execute on function public.get_public_catalog(text) to anon, authenticated;

-- Stockage : bucket public en lecture (images/vidéos), écriture réservée au vendeur dans son dossier <user_id>/
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-media', 'product-media', true, 52428800,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'])
on conflict (id) do nothing;

create policy "media upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "media update own folder" on storage.objects for update to authenticated
  using (bucket_id = 'product-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "media delete own folder" on storage.objects for delete to authenticated
  using (bucket_id = 'product-media' and (storage.foldername(name))[1] = auth.uid()::text);
