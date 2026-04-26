-- Remove obvious invalid Chilean RUT identifiers from base tables.
-- In this project rutid is stored as 10 characters: zero-padded body + DV.
-- The cleanup removes:
-- - rows whose rutid is not 10 chars or does not match [0-9]{9}[0-9K]
-- - ultra-low padded identifiers below 0001000000, e.g. 0000000019
-- - repeated digit garbage, e.g. 1111111111

set statement_timeout = 0;

delete from public.contact_center_feedback
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$'
  or char_length(coalesce(matched_rutid, '')) <> 10
  or (matched_rutid >= '0000000000' and matched_rutid < '0001000000')
  or matched_rutid ~ '^([0-9])\1{9}$'
  or matched_rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.equifax_generation_run_items
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.equifax_lead_features
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.equifax_lead_scores
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.equifax_sales_history
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.company_name_lookup
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.wom_customer_signals
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.import_personas_master_stage
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.persona_contact_points_rebuild_stage
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.personas_master_rebuild_stage
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.persona_contact_points
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.persona_scores
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.personas_master
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.padron_personas_raw
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public.bbrr_propiedades
where char_length(coalesce(rutid, '')) <> 10
  or (rutid >= '0000000000' and rutid < '0001000000')
  or rutid ~ '^([0-9])\1{9}$'
  or rutid !~ '^[0-9]{9}[0-9K]$';

delete from public._bbrr_rollup_work
where char_length(coalesce(rutid::varchar(20), '')) <> 10
  or (rutid::varchar(20) >= '0000000000' and rutid::varchar(20) < '0001000000')
  or rutid::varchar(20) ~ '^([0-9])\1{9}$'
  or rutid::varchar(20) !~ '^[0-9]{9}[0-9K]$';
