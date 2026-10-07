-- Audiencias de correo para Atlas CRM (contrato bigdata.audiencia.v1).
--
-- Atlas CRM arma campañas de correo y elige a quién escribir filtrando la base
-- de Bigdata: región, comuna, rubro, tamaño, trabajadores, cargo del contacto.
-- Filtrar en vivo sobre empresas_master (1,4 millones de filas) tomaba 7,5 s
-- por consulta, así que los contactos con correo se precalculan en una vista
-- materializada liviana (una fila por correo de ejecutivo o correo general de
-- la empresa), con la región escrita de una sola forma y el cargo agrupado.
-- Se refresca todas las noches con pg_cron; la lista negra se vuelve a revisar
-- en cada página, porque un rebote de hoy no puede esperar a mañana.
--
-- Idempotente.

create or replace function public.atlas_region_canonica(valor text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when v is null or v = '' then null
    when v ~ 'METROPOLITANA|SANTIAGO' then 'Metropolitana de Santiago'
    when v ~ 'VALPARAISO' then 'Valparaíso'
    when v ~ 'BIO ?BIO' then 'Biobío'
    when v ~ 'LOS LAGOS' then 'Los Lagos'
    when v ~ 'ARAUCANIA' then 'La Araucanía'
    when v ~ 'MAULE' then 'Maule'
    when v ~ 'HIGGINS|LIBERTADOR' then 'Libertador General Bernardo O''Higgins'
    when v ~ 'COQUIMBO' then 'Coquimbo'
    when v ~ 'ANTOFAGASTA' then 'Antofagasta'
    when v ~ 'NUBLE' then 'Ñuble'
    when v ~ 'LOS RIOS' then 'Los Ríos'
    when v ~ 'TARAPACA' then 'Tarapacá'
    when v ~ 'ATACAMA' then 'Atacama'
    when v ~ 'MAGALLANES' then 'Magallanes y de la Antártica Chilena'
    when v ~ 'ARICA' then 'Arica y Parinacota'
    when v ~ 'AYSEN' then 'Aysén del General Carlos Ibáñez del Campo'
    else null
  end
  from (select upper(translate(coalesce(valor, ''), 'ÁÉÍÓÚÑáéíóúñ', 'AEIOUNaeioun')) as v) normalizado;
$$;

-- Tramo de ventas del SII → tamaño: 1 sin ventas, 2–4 micro, 5–7 pequeña, 8–9 mediana, 10–13 grande.
create or replace function public.atlas_tamano_empresa(tramo integer)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when tramo between 2 and 4 then 'micro'
    when tramo between 5 and 7 then 'pequena'
    when tramo between 8 and 9 then 'mediana'
    when tramo between 10 and 13 then 'grande'
    else 'sin_info'
  end;
$$;

-- Grupos de cargo para filtrar sin escribir el cargo exacto (viene en texto libre).
create or replace function public.atlas_grupos_de_cargo(cargo text, area text)
returns text[]
language sql
immutable
parallel safe
as $$
  select coalesce(array_remove(array[
    case when c ~ 'GERENTE GENERAL|GERENTE GRAL|\mCEO\M' then 'gerente_general' end,
    case when c ~ 'GERENTE|\mGTE\M|\mCEO\M|\mCFO\M|\mCOO\M|\mCTO\M' then 'gerencia' end,
    case when c ~ 'REPRESENTANTE LEGAL|REP\. LEGAL' then 'representante_legal' end,
    case when c ~ 'DUENO|SOCIO|PROPIETARIO|PRESIDENTE|DIRECTOR' or a ~ 'DIRECTORIO' then 'dueno_directorio' end,
    case when c ~ 'COMERCIAL|VENTAS|NEGOCIOS' or a ~ 'COMERCIAL|VENTAS' then 'comercial' end,
    case when c ~ 'FINANZAS|FINANCIER|CONTAB|ADMINISTRACION|TESORER|\mCFO\M' or a ~ 'FINANZAS|ADMINISTRACION' then 'finanzas' end,
    case when c ~ 'OPERACION|PRODUCCION|LOGISTIC|PLANTA|\mCOO\M' or a ~ 'OPERACION|PRODUCCION' then 'operaciones' end,
    case when c ~ 'RECURSOS HUMANOS|RRHH|PERSONAS|REMUNERACION' or a ~ 'RECURSOS HUMANOS|PERSONAS' then 'personas' end,
    case when c ~ 'INFORMATICA|SISTEMAS|TECNOLOG|\mTI\M|\mCTO\M|DIGITAL' or a ~ 'INFORMATICA|SISTEMAS|TECNOLOG' then 'tecnologia' end,
    case when c ~ 'MARKETING|COMUNICACION|MARCA' or a ~ 'MARKETING' then 'marketing' end
  ], null), '{}')
  from (select upper(translate(coalesce(cargo, ''), 'ÁÉÍÓÚÑáéíóúñ', 'AEIOUNaeioun')) as c,
               upper(translate(coalesce(area, ''), 'ÁÉÍÓÚÑáéíóúñ', 'AEIOUNaeioun')) as a) normalizado;
$$;

drop materialized view if exists public.atlas_audiencia_contactos;

create materialized view public.atlas_audiencia_contactos as
with lista_negra as materialized (
  select distinct normalized_value as email
  from public.contact_blacklist
  where contact_type = 'email' and normalized_value is not null
),
emp as (
  select
    e.rutid,
    nullif(e.dv, '') as dv,
    nullif(trim(e.razon_social), '') as razon_social,
    public.atlas_region_canonica(e.region) as region,
    nullif(upper(trim(e.comuna)), '') as comuna,
    nullif(trim(e.rubro_economico_ultimo), '') as rubro,
    nullif(trim(e.subrubro_economico_ultimo), '') as subrubro,
    e.tramo_ventas_2024 as tramo_ventas,
    public.atlas_tamano_empresa(e.tramo_ventas_2024) as tamano,
    e.trabajadores_2024 as trabajadores,
    coalesce(e.sii_activa_sin_termino_giro, false) as activa,
    coalesce(e.es_cliente_equifax, false) as cliente_equifax,
    lower(trim(nullif(e.mejor_email, ''))) as mejor_email,
    coalesce(e.email_en_blacklist, false) as email_en_blacklist,
    nullif(e.mejor_fono, '') as mejor_fono,
    coalesce(e.ejecutivo_email, '') <> '' as con_ejecutivo
  from public.empresas_master e
  where coalesce(e.mejor_email, '') <> '' or coalesce(e.ejecutivo_email, '') <> ''
),
ejecutivo as (
  select distinct on (x.rutid, lower(trim(x.email)))
    x.rutid,
    lower(trim(x.email)) as email,
    nullif(trim(x.nombre_ejecutivo), '') as nombre,
    nullif(trim(x.cargo), '') as cargo,
    nullif(trim(x.area), '') as area,
    public.normalize_ejecutivo_phone(x.fono_area_cel, x.fono_numero_cel) as telefono
  from public.ejecutivos x
  join emp on emp.rutid = x.rutid
  where x.email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}$'
  order by x.rutid, lower(trim(x.email)), public.ejecutivo_contact_priority(x.cargo), x.id
),
filas as (
  select emp.*, j.email, 'ejecutivo'::text as origen, j.nombre, j.cargo, j.area,
         public.atlas_grupos_de_cargo(j.cargo, j.area) as grupos_cargo,
         coalesce(j.telefono, emp.mejor_fono) as telefono
  from ejecutivo j
  join emp on emp.rutid = j.rutid
  union all
  select emp.*, emp.mejor_email, 'empresa', null, null, null, '{}'::text[], emp.mejor_fono
  from emp
  where emp.mejor_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}$'
    and not emp.email_en_blacklist
    and not exists (select 1 from ejecutivo j where j.rutid = emp.rutid and j.email = emp.mejor_email)
)
select
  f.rutid || ':' || f.email as id,
  f.rutid, f.dv, f.razon_social, f.region, f.comuna, f.rubro, f.subrubro,
  f.tramo_ventas, f.tamano, f.trabajadores, f.activa, f.cliente_equifax, f.con_ejecutivo,
  f.email, f.origen, f.nombre, f.cargo, f.area, f.grupos_cargo, f.telefono
from filas f
where not exists (select 1 from lista_negra b where b.email = f.email);

create unique index atlas_audiencia_contactos_id_idx on public.atlas_audiencia_contactos (id);
create index atlas_audiencia_contactos_region_idx on public.atlas_audiencia_contactos (region);
create index atlas_audiencia_contactos_rubro_idx on public.atlas_audiencia_contactos (rubro);
create index atlas_audiencia_contactos_tamano_idx on public.atlas_audiencia_contactos (tamano);
create index atlas_audiencia_contactos_grupos_idx on public.atlas_audiencia_contactos using gin (grupos_cargo);

comment on materialized view public.atlas_audiencia_contactos is
  'Contactos con correo para audiencias de campañas de Atlas CRM (bigdata.audiencia.v1). Se refresca cada noche; la lista negra se revisa también en cada página.';

revoke all on public.atlas_audiencia_contactos from anon, authenticated;

-- Cuándo se refrescó por última vez (la vista materializada no lo guarda).
create table if not exists public.atlas_audiencia_estado (
  id boolean primary key default true check (id),
  last_refresh timestamptz not null default now(),
  filas bigint
);
alter table public.atlas_audiencia_estado enable row level security;
revoke all on public.atlas_audiencia_estado from anon, authenticated;

insert into public.atlas_audiencia_estado (id, last_refresh, filas)
values (true, now(), (select count(*) from public.atlas_audiencia_contactos))
on conflict (id) do update set last_refresh = excluded.last_refresh, filas = excluded.filas;

-- Filtros (todos opcionales):
-- { "regiones": [...], "comunas": [...], "rubros": [...], "tamanos": ["micro","pequena","mediana","grande","sin_info"],
--   "trabajadores_min": 10, "trabajadores_max": 200, "solo_activas": true, "excluir_clientes_equifax": false,
--   "contacto": "ejecutivos" | "empresa" | "ambos", "cargos": ["gerente_general", ...], "nombre_contiene": "..." }
create or replace function public.atlas_audiencia_filtrar(f jsonb)
returns setof public.atlas_audiencia_contactos
language sql
stable
set search_path to 'pg_catalog', 'public'
as $$
  with p as (
    select
      (select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(f->'regiones') = 'array' then f->'regiones' end) x) as regiones,
      (select array_agg(upper(x)) from jsonb_array_elements_text(case when jsonb_typeof(f->'comunas') = 'array' then f->'comunas' end) x) as comunas,
      (select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(f->'rubros') = 'array' then f->'rubros' end) x) as rubros,
      (select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(f->'tamanos') = 'array' then f->'tamanos' end) x) as tamanos,
      (select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(f->'cargos') = 'array' then f->'cargos' end) x) as cargos,
      nullif(f->>'trabajadores_min', '')::integer as trabajadores_min,
      nullif(f->>'trabajadores_max', '')::integer as trabajadores_max,
      coalesce((f->>'solo_activas')::boolean, true) as solo_activas,
      coalesce((f->>'excluir_clientes_equifax')::boolean, false) as excluir_clientes_equifax,
      coalesce(nullif(f->>'contacto', ''), 'ambos') as contacto,
      nullif(trim(f->>'nombre_contiene'), '') as nombre_contiene
  )
  select c.*
  from public.atlas_audiencia_contactos c, p
  where (p.regiones is null or cardinality(p.regiones) = 0 or c.region = any (p.regiones))
    and (p.comunas is null or cardinality(p.comunas) = 0 or c.comuna = any (p.comunas))
    and (p.rubros is null or cardinality(p.rubros) = 0 or c.rubro = any (p.rubros))
    and (p.tamanos is null or cardinality(p.tamanos) = 0 or c.tamano = any (p.tamanos))
    and (p.trabajadores_min is null or c.trabajadores >= p.trabajadores_min)
    and (p.trabajadores_max is null or c.trabajadores <= p.trabajadores_max)
    and (not p.solo_activas or c.activa)
    and (not p.excluir_clientes_equifax or not c.cliente_equifax)
    and (p.nombre_contiene is null or c.razon_social ilike '%' || p.nombre_contiene || '%')
    and (
      (c.origen = 'ejecutivo' and p.contacto in ('ejecutivos', 'ambos')
        and (p.cargos is null or cardinality(p.cargos) = 0 or c.grupos_cargo && p.cargos))
      or (c.origen = 'empresa' and (p.contacto = 'empresa' or (p.contacto = 'ambos' and not c.con_ejecutivo)))
    );
$$;

create or replace function public.atlas_audiencia_contar(f jsonb)
returns jsonb
language sql
stable
set search_path to 'pg_catalog', 'public'
as $$
  select jsonb_build_object(
    'contactos', count(*),
    'empresas', count(distinct rutid),
    'ejecutivos', count(*) filter (where origen = 'ejecutivo'),
    'correos_generales', count(*) filter (where origen = 'empresa'),
    'actualizada_at', (select max(last_refresh) from public.atlas_audiencia_estado)
  )
  from public.atlas_audiencia_filtrar(f);
$$;

create or replace function public.atlas_audiencia_pagina(f jsonb, despues text, limite integer)
returns jsonb
language sql
stable
set search_path to 'pg_catalog', 'public'
as $$
  with tope as (
    select least(greatest(coalesce(limite, 500), 1), 1000) as n
  ),
  pagina as (
    select c.*
    from public.atlas_audiencia_filtrar(f) c
    where despues is null or c.id > despues
    order by c.id
    limit (select n from tope)
  ),
  -- Un rebote de hoy no espera al refresco de la noche.
  bloqueados as (
    select distinct b.normalized_value as email
    from public.contact_blacklist b
    where b.contact_type = 'email' and b.normalized_value in (select email from pagina)
  ),
  limpias as (
    select p.* from pagina p where not exists (select 1 from bloqueados b where b.email = p.email)
  )
  select jsonb_build_object(
    'filas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'referencia', l.id,
        'rut', ltrim(l.rutid, '0') || coalesce('-' || l.dv, ''),
        'empresa', l.razon_social,
        'email', l.email,
        'origen', l.origen,
        'nombre', l.nombre,
        'cargo', l.cargo,
        'area', l.area,
        'telefono', l.telefono,
        'region', l.region,
        'comuna', l.comuna,
        'rubro', l.rubro,
        'tamano', l.tamano,
        'trabajadores', l.trabajadores
      ) order by l.id)
      from limpias l), '[]'::jsonb),
    'siguiente', (select case when count(*) = (select n from tope) then max(id) end from pagina),
    'bloqueados', (select count(*) from bloqueados)
  );
$$;

create or replace function public.atlas_audiencia_opciones(f jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
set search_path to 'pg_catalog', 'public'
as $$
  with regiones_elegidas as (
    select array_agg(x) as r from jsonb_array_elements_text(case when jsonb_typeof(f->'regiones') = 'array' then f->'regiones' end) x
  )
  select jsonb_build_object(
    'regiones', (select coalesce(jsonb_agg(jsonb_build_object('valor', region, 'contactos', n) order by n desc), '[]'::jsonb)
                 from (select region, count(*) n from public.atlas_audiencia_contactos where region is not null group by region) t),
    'rubros', (select coalesce(jsonb_agg(jsonb_build_object('valor', rubro, 'contactos', n) order by n desc), '[]'::jsonb)
               from (select rubro, count(*) n from public.atlas_audiencia_contactos where rubro is not null group by rubro) t),
    'tamanos', (select coalesce(jsonb_agg(jsonb_build_object('valor', tamano, 'contactos', n) order by n desc), '[]'::jsonb)
                from (select tamano, count(*) n from public.atlas_audiencia_contactos group by tamano) t),
    'cargos', (select coalesce(jsonb_agg(jsonb_build_object('valor', g, 'contactos', n) order by n desc), '[]'::jsonb)
               from (select g, count(*) n from public.atlas_audiencia_contactos, unnest(grupos_cargo) g group by g) t),
    'comunas', (select coalesce(jsonb_agg(jsonb_build_object('valor', comuna, 'region', region, 'contactos', n) order by n desc), '[]'::jsonb)
                from (select comuna, region, count(*) n
                      from public.atlas_audiencia_contactos, regiones_elegidas
                      where comuna is not null and regiones_elegidas.r is not null and region = any (regiones_elegidas.r)
                      group by comuna, region
                      order by n desc
                      limit 400) t),
    'actualizada_at', (select max(last_refresh) from public.atlas_audiencia_estado)
  );
$$;

create or replace function public.atlas_audiencia_refrescar()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
set statement_timeout to '10min'
as $$
begin
  refresh materialized view concurrently public.atlas_audiencia_contactos;
  insert into public.atlas_audiencia_estado (id, last_refresh, filas)
  values (true, now(), (select count(*) from public.atlas_audiencia_contactos))
  on conflict (id) do update set last_refresh = excluded.last_refresh, filas = excluded.filas;
end;
$$;

revoke all on function public.atlas_audiencia_filtrar(jsonb) from public, anon, authenticated;
revoke all on function public.atlas_audiencia_contar(jsonb) from public, anon, authenticated;
revoke all on function public.atlas_audiencia_pagina(jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.atlas_audiencia_opciones(jsonb) from public, anon, authenticated;
revoke all on function public.atlas_audiencia_refrescar() from public, anon, authenticated;
grant execute on function public.atlas_audiencia_filtrar(jsonb) to service_role;
grant execute on function public.atlas_audiencia_contar(jsonb) to service_role;
grant execute on function public.atlas_audiencia_pagina(jsonb, text, integer) to service_role;
grant execute on function public.atlas_audiencia_opciones(jsonb) to service_role;
grant execute on function public.atlas_audiencia_refrescar() to service_role;

-- Refresco nocturno, después del recuento de la lista negra (07:20 UTC).
select cron.unschedule(jobid) from cron.job where jobname = 'atlas_audiencia_refrescar';
select cron.schedule('atlas_audiencia_refrescar', '50 7 * * *', 'select public.atlas_audiencia_refrescar();');
