-- pg_stat_statements showed the two company-name searches averaging ~8.6s;
-- EXPLAIN confirmed a parallel sequential scan over empresas_master and the
-- live schema had no index covering razon_social.
create index if not exists empresas_master_razon_social_trgm_idx
  on public.empresas_master
  using gin (razon_social public.gin_trgm_ops);
