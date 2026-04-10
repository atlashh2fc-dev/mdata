#!/usr/bin/env node

import { Client } from 'pg'

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    rebuildStage: argv.includes('--rebuild-stage'),
    resumeStage: argv.includes('--resume-stage'),
    applyExistingStage: argv.includes('--apply-existing-stage'),
  }
}

function sanitizeConnectionString(rawValue) {
  const url = new URL(rawValue)
  for (const key of [
    'ssl',
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'sslaccept',
    'sslacceptmode',
    'uselibpqcompat',
    'pgbouncer',
    'supa',
  ]) {
    url.searchParams.delete(key)
  }
  return url.toString()
}

function resolvePgConfig() {
  const connectionString =
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRES_PRISMA_URL ??
    process.env.DATABASE_URL ??
    process.env.SUPABASE_DB_URL ??
    null

  if (!connectionString) {
    throw new Error('Faltan credenciales Postgres.')
  }

  return {
    connectionString: sanitizeConnectionString(connectionString),
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

const PERSONAS_MASTER_SECONDARY_INDEXES = [
  [
    'idx_personas_master_company_match_key',
    `CREATE INDEX IF NOT EXISTS idx_personas_master_company_match_key
      ON public.personas_master USING btree (normalize_company_name((razon_social_empresa)::text))
      WHERE razon_social_empresa IS NOT NULL`,
  ],
  [
    'idx_pm_autos',
    `CREATE INDEX IF NOT EXISTS idx_pm_autos
      ON public.personas_master USING btree (n_autos)
      WHERE n_autos > 0`,
  ],
  [
    'idx_pm_bienes',
    `CREATE INDEX IF NOT EXISTS idx_pm_bienes
      ON public.personas_master USING btree (n_bienes_raices)
      WHERE n_bienes_raices > 0`,
  ],
  [
    'idx_pm_comuna',
    `CREATE INDEX IF NOT EXISTS idx_pm_comuna
      ON public.personas_master USING btree (comuna_part)
      WHERE comuna_part IS NOT NULL`,
  ],
  [
    'idx_pm_email',
    `CREATE INDEX IF NOT EXISTS idx_pm_email
      ON public.personas_master USING btree (email)
      WHERE email IS NOT NULL`,
  ],
  [
    'idx_pm_empresa',
    `CREATE INDEX IF NOT EXISTS idx_pm_empresa
      ON public.personas_master USING btree (razon_social_empresa)
      WHERE razon_social_empresa IS NOT NULL`,
  ],
  [
    'idx_pm_fono',
    `CREATE INDEX IF NOT EXISTS idx_pm_fono
      ON public.personas_master USING btree (fono_cel)
      WHERE fono_cel IS NOT NULL`,
  ],
  [
    'idx_pm_nombre_trgm',
    `CREATE INDEX IF NOT EXISTS idx_pm_nombre_trgm
      ON public.personas_master USING gin (
        (COALESCE(nombres,'') || ' ' || COALESCE(paterno,'') || ' ' || COALESCE(materno,''))
        gin_trgm_ops
      )`,
  ],
  [
    'idx_pm_region',
    `CREATE INDEX IF NOT EXISTS idx_pm_region
      ON public.personas_master USING btree (region_part)
      WHERE region_part IS NOT NULL`,
  ],
]

async function dropPersonasMasterSecondaryIndexes(pgClient) {
  log('[apply] eliminando indices secundarios de personas_master para carga masiva...')
  for (const [indexName] of PERSONAS_MASTER_SECONDARY_INDEXES) {
    await pgClient.query(`DROP INDEX IF EXISTS public.${indexName}`)
  }
}

async function recreatePersonasMasterSecondaryIndexes(pgClient) {
  log('[apply] recreando indices secundarios de personas_master...')
  await pgClient.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
  for (const [, createSql] of PERSONAS_MASTER_SECONDARY_INDEXES) {
    await pgClient.query(createSql)
  }
}

async function tableExists(pgClient, tableName) {
  const result = await pgClient.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${tableName}`])
  return Boolean(result.rows[0]?.exists)
}

async function constraintExists(pgClient, constraintName) {
  const result = await pgClient.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = $1
    ) AS exists
  `, [constraintName])
  return Boolean(result.rows[0]?.exists)
}

async function trySet(pgClient, sql) {
  try {
    await pgClient.query(sql)
  } catch (error) {
    log(`[warn] no se pudo aplicar ${sql}: ${error.message}`)
  }
}

async function ensureRutHelpers(pgClient) {
  await pgClient.query(`
    CREATE OR REPLACE FUNCTION public.calc_rut_dv(digits text)
    RETURNS text
    LANGUAGE plpgsql
    IMMUTABLE
    AS $$
    DECLARE
      clean text := regexp_replace(COALESCE(digits, ''), '\\D', '', 'g');
      total integer := 0;
      multiplier integer := 2;
      idx integer;
      remainder integer;
    BEGIN
      IF clean = '' THEN
        RETURN NULL;
      END IF;

      FOR idx IN REVERSE length(clean)..1 LOOP
        total := total + CAST(substr(clean, idx, 1) AS integer) * multiplier;
        multiplier := CASE WHEN multiplier = 7 THEN 2 ELSE multiplier + 1 END;
      END LOOP;

      remainder := 11 - (total % 11);
      IF remainder = 11 THEN
        RETURN '0';
      ELSIF remainder = 10 THEN
        RETURN 'K';
      END IF;

      RETURN remainder::text;
    END;
    $$;
  `)

  await pgClient.query(`
    CREATE OR REPLACE FUNCTION public.normalize_master_rutid(value text)
    RETURNS varchar(20)
    LANGUAGE plpgsql
    IMMUTABLE
    AS $$
    DECLARE
      clean text := upper(regexp_replace(COALESCE(value, ''), '[^0-9K]', '', 'g'));
      digits text;
      dv text;
    BEGIN
      IF clean = '' THEN
        RETURN NULL;
      END IF;

      IF clean ~ '^[0-9]{1,9}[0-9K]$' THEN
        digits := substr(clean, 1, length(clean) - 1);
        dv := right(clean, 1);
        IF public.calc_rut_dv(digits) = dv THEN
          RETURN lpad(digits || dv, 10, '0');
        END IF;
      END IF;

      digits := regexp_replace(clean, '[^0-9]', '', 'g');
      digits := regexp_replace(digits, '^0+', '');

      IF digits = '' THEN
        RETURN NULL;
      END IF;

      RETURN lpad(digits || public.calc_rut_dv(digits), 10, '0');
    END;
    $$;
  `)
}

async function buildStages(pgClient, { forceRebuild = true } = {}) {
  log('Construyendo staging canonico de personas_master...')

  if (forceRebuild) await pgClient.query('DROP TABLE IF EXISTS public.personas_master_rutid_map')
  if (forceRebuild || !(await tableExists(pgClient, 'personas_master_rutid_map'))) {
    await pgClient.query(`
      CREATE UNLOGGED TABLE public.personas_master_rutid_map AS
      SELECT
        pm.rutid AS old_rutid,
        keys.canonical_rutid AS new_rutid
    FROM public.personas_master pm
    JOIN public._padron2024_fix_keys keys
      ON keys.bad_rutid = pm.rutid
    WHERE keys.canonical_rutid IS DISTINCT FROM pm.rutid
      AND NOT EXISTS (
        SELECT 1
        FROM public._padron2024_fix_keys canonical_target
        WHERE canonical_target.canonical_rutid = pm.rutid
      )
  `)
  } else {
    log('[stage] reutilizando personas_master_rutid_map existente.')
  }
  await pgClient.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS personas_master_rutid_map_old_idx
      ON public.personas_master_rutid_map (old_rutid)
  `)
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS personas_master_rutid_map_new_idx
      ON public.personas_master_rutid_map (new_rutid)
  `)

  if (forceRebuild) await pgClient.query('DROP TABLE IF EXISTS public.personas_master_rebuild_stage')
  if (forceRebuild || !(await tableExists(pgClient, 'personas_master_rebuild_stage'))) {
    await pgClient.query(`
      CREATE UNLOGGED TABLE public.personas_master_rebuild_stage AS
    WITH normalized_source AS (
      SELECT
        COALESCE(rutid_map.new_rutid, pm.rutid) AS rutid,
        NULLIF(TRIM(pm.nombres), '') AS nombres,
        NULLIF(TRIM(pm.paterno), '') AS paterno,
        NULLIF(TRIM(pm.materno), '') AS materno,
        NULLIF(TRIM(pm.email), '') AS email,
        NULLIF(TRIM(pm.fono_cel), '') AS fono_cel,
        NULLIF(TRIM(pm.comuna_part), '') AS comuna_part,
        NULLIF(TRIM(pm.region_part), '') AS region_part,
        GREATEST(COALESCE(pm.n_autos, 0), 0) AS n_autos,
        NULLIF(TRIM(pm.razon_social_empresa), '') AS razon_social_empresa,
        NULLIF(TRIM(pm.domicilio_comuna), '') AS domicilio_comuna,
        NULLIF(TRIM(pm.domicilio_region), '') AS domicilio_region,
        GREATEST(COALESCE(pm.n_bienes_raices, 0), 0) AS n_bienes_raices,
        GREATEST(COALESCE(pm.totalavaluos, 0), 0) AS totalavaluos,
        pm.loaded_at,
        (
          CASE WHEN NULLIF(TRIM(pm.nombres), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.paterno), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.materno), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.email), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.fono_cel), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.comuna_part), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.region_part), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.razon_social_empresa), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.domicilio_comuna), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN NULLIF(TRIM(pm.domicilio_region), '') IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(pm.n_autos, 0) > 0 THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(pm.n_bienes_raices, 0) > 0 THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(pm.totalavaluos, 0) > 0 THEN 1 ELSE 0 END
        ) AS quality_score
      FROM public.personas_master pm
      LEFT JOIN public.personas_master_rutid_map rutid_map
        ON rutid_map.old_rutid = pm.rutid
    )
    SELECT
      rutid,
      MAX(nombres) FILTER (WHERE nombres IS NOT NULL) AS nombres,
      MAX(paterno) FILTER (WHERE paterno IS NOT NULL) AS paterno,
      MAX(materno) FILTER (WHERE materno IS NOT NULL) AS materno,
      MAX(email) FILTER (WHERE email IS NOT NULL) AS email,
      MAX(fono_cel) FILTER (WHERE fono_cel IS NOT NULL) AS fono_cel,
      MAX(comuna_part) FILTER (WHERE comuna_part IS NOT NULL) AS comuna_part,
      MAX(region_part) FILTER (WHERE region_part IS NOT NULL) AS region_part,
      MAX(n_autos) AS n_autos,
      MAX(razon_social_empresa) FILTER (WHERE razon_social_empresa IS NOT NULL) AS razon_social_empresa,
      MAX(domicilio_comuna) FILTER (WHERE domicilio_comuna IS NOT NULL) AS domicilio_comuna,
      MAX(domicilio_region) FILTER (WHERE domicilio_region IS NOT NULL) AS domicilio_region,
      MAX(n_bienes_raices) AS n_bienes_raices,
      MAX(totalavaluos) AS totalavaluos,
      MAX(loaded_at) AS loaded_at
    FROM normalized_source
    GROUP BY rutid
    `)
  } else {
    log('[stage] reutilizando personas_master_rebuild_stage existente.')
  }
  if (!(await constraintExists(pgClient, 'personas_master_rebuild_stage_pkey'))) {
    await pgClient.query(`
      ALTER TABLE public.personas_master_rebuild_stage
        ADD CONSTRAINT personas_master_rebuild_stage_pkey PRIMARY KEY (rutid)
    `)
  }

  if (forceRebuild) await pgClient.query('DROP TABLE IF EXISTS public.persona_contact_points_rebuild_stage')
  if (forceRebuild || !(await tableExists(pgClient, 'persona_contact_points_rebuild_stage'))) {
    await pgClient.query(`
      CREATE UNLOGGED TABLE public.persona_contact_points_rebuild_stage AS
    WITH normalized AS (
      SELECT
        pcp.id,
        COALESCE(rutid_map.new_rutid, pcp.rutid) AS rutid,
        pcp.contact_type,
        pcp.contact_value,
        pcp.normalized_value,
        pcp.source_name,
        pcp.source_priority,
        pcp.quality_score,
        pcp.is_primary,
        pcp.is_verified,
        pcp.is_deliverable,
        pcp.first_seen_at,
        pcp.last_seen_at,
        pcp.last_feedback_at,
        pcp.metadata,
        pcp.created_at,
        pcp.updated_at
      FROM public.persona_contact_points pcp
      LEFT JOIN public.personas_master_rutid_map rutid_map
        ON rutid_map.old_rutid = pcp.rutid
    ),
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY rutid, contact_type, normalized_value
          ORDER BY
            is_primary DESC,
            quality_score DESC,
            source_priority ASC,
            COALESCE(last_feedback_at, last_seen_at, updated_at, created_at) DESC,
            updated_at DESC,
            created_at DESC,
            id
        ) AS rn
      FROM normalized
    )
    SELECT
      id,
      rutid,
      contact_type,
      contact_value,
      normalized_value,
      source_name,
      source_priority,
      quality_score,
      is_primary,
      is_verified,
      is_deliverable,
      first_seen_at,
      last_seen_at,
      last_feedback_at,
      metadata,
      created_at,
      updated_at
    FROM ranked
    WHERE rn = 1
    `)
  } else {
    log('[stage] reutilizando persona_contact_points_rebuild_stage existente.')
  }
  await pgClient.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS persona_contact_points_rebuild_stage_unique
      ON public.persona_contact_points_rebuild_stage (rutid, contact_type, normalized_value)
  `)

  const checks = [
    ['personas_master_actual', 'SELECT COUNT(*)::bigint AS total FROM public.personas_master'],
    ['personas_master_stage', 'SELECT COUNT(*)::bigint AS total FROM public.personas_master_rebuild_stage'],
    ['rutid_changes', 'SELECT COUNT(*)::bigint AS total FROM public.personas_master_rutid_map'],
    ['contact_points_actual', 'SELECT COUNT(*)::bigint AS total FROM public.persona_contact_points'],
    ['contact_points_stage', 'SELECT COUNT(*)::bigint AS total FROM public.persona_contact_points_rebuild_stage'],
  ]

  for (const [label, sql] of checks) {
    const result = await pgClient.query(sql)
    log(`[stage] ${label}=${result.rows[0]?.total ?? 0}`)
  }
}

async function applyRebuild(pgClient) {
  log('Aplicando reconstruccion canonica sobre personas_master...')

  await pgClient.query(`
    WITH mapped AS (
      SELECT
        feedback.ctid,
        COALESCE(rutid_map.new_rutid, feedback.rutid) AS rutid,
        COALESCE(matched_map.new_rutid, feedback.matched_rutid) AS matched_rutid
      FROM public.contact_center_feedback feedback
      LEFT JOIN public.personas_master_rutid_map rutid_map
        ON rutid_map.old_rutid = feedback.rutid
      LEFT JOIN public.personas_master_rutid_map matched_map
        ON matched_map.old_rutid = feedback.matched_rutid
      WHERE rutid_map.old_rutid IS NOT NULL
        OR matched_map.old_rutid IS NOT NULL
    )
    UPDATE public.contact_center_feedback feedback
    SET
      rutid = mapped.rutid,
      matched_rutid = mapped.matched_rutid,
      updated_at = NOW()
    FROM mapped
    WHERE feedback.ctid = mapped.ctid
  `)

  await pgClient.query(`
    CREATE TEMP TABLE company_name_lookup_rebuild AS
    SELECT DISTINCT ON (COALESCE(rutid_map.new_rutid, company_lookup.rutid))
      COALESCE(rutid_map.new_rutid, company_lookup.rutid) AS rutid,
      company_lookup.razon_social_empresa,
      company_lookup.match_key
    FROM public.company_name_lookup company_lookup
    LEFT JOIN public.personas_master_rutid_map rutid_map
      ON rutid_map.old_rutid = company_lookup.rutid
    ORDER BY COALESCE(rutid_map.new_rutid, company_lookup.rutid), length(company_lookup.razon_social_empresa) DESC, company_lookup.rutid
  `)

  let indexesDropped = false
  await dropPersonasMasterSecondaryIndexes(pgClient)
  indexesDropped = true

  await pgClient.query('BEGIN')
  try {
    await pgClient.query('LOCK TABLE public.personas_master IN ACCESS EXCLUSIVE MODE')
    await pgClient.query('LOCK TABLE public.persona_contact_points IN ACCESS EXCLUSIVE MODE')
    await pgClient.query('LOCK TABLE public.persona_scores IN ACCESS EXCLUSIVE MODE')

    await pgClient.query('ALTER TABLE public.persona_contact_points DROP CONSTRAINT IF EXISTS persona_contact_points_rutid_fkey')
    await pgClient.query('ALTER TABLE public.persona_scores DROP CONSTRAINT IF EXISTS persona_scores_rutid_fkey')

    await pgClient.query('TRUNCATE TABLE public.persona_scores')
    await pgClient.query('TRUNCATE TABLE public.persona_contact_points')
    await pgClient.query('TRUNCATE TABLE public.personas_master')

    await pgClient.query(`
      INSERT INTO public.personas_master (
        rutid,
        nombres,
        paterno,
        materno,
        email,
        fono_cel,
        comuna_part,
        region_part,
        n_autos,
        razon_social_empresa,
        domicilio_comuna,
        domicilio_region,
        n_bienes_raices,
        totalavaluos,
        loaded_at
      )
      SELECT
        rutid,
        nombres,
        paterno,
        materno,
        email,
        fono_cel,
        comuna_part,
        region_part,
        n_autos,
        razon_social_empresa,
        domicilio_comuna,
        domicilio_region,
        n_bienes_raices,
        totalavaluos,
        loaded_at
      FROM public.personas_master_rebuild_stage
    `)

    await pgClient.query(`
      INSERT INTO public.persona_contact_points (
        id,
        rutid,
        contact_type,
        contact_value,
        normalized_value,
        source_name,
        source_priority,
        quality_score,
        is_primary,
        is_verified,
        is_deliverable,
        first_seen_at,
        last_seen_at,
        last_feedback_at,
        metadata,
        created_at,
        updated_at
      )
      SELECT
        id,
        rutid,
        contact_type,
        contact_value,
        normalized_value,
        source_name,
        source_priority,
        quality_score,
        is_primary,
        is_verified,
        is_deliverable,
        first_seen_at,
        last_seen_at,
        last_feedback_at,
        metadata,
        created_at,
        updated_at
      FROM public.persona_contact_points_rebuild_stage
    `)

    await pgClient.query(`
      ALTER TABLE public.persona_contact_points
        ADD CONSTRAINT persona_contact_points_rutid_fkey
        FOREIGN KEY (rutid) REFERENCES public.personas_master(rutid) ON DELETE CASCADE
    `)
    await pgClient.query(`
      ALTER TABLE public.persona_scores
        ADD CONSTRAINT persona_scores_rutid_fkey
        FOREIGN KEY (rutid) REFERENCES public.personas_master(rutid) ON DELETE CASCADE
    `)

    await pgClient.query('COMMIT')
  } catch (error) {
    await pgClient.query('ROLLBACK')
    throw error
  } finally {
    if (indexesDropped) {
      await recreatePersonasMasterSecondaryIndexes(pgClient)
      indexesDropped = false
    }
  }

  await pgClient.query('TRUNCATE TABLE public.company_name_lookup')
  await pgClient.query(`
    INSERT INTO public.company_name_lookup (rutid, razon_social_empresa, match_key)
    SELECT rutid, razon_social_empresa, match_key
    FROM company_name_lookup_rebuild
  `)

  await pgClient.query(`
    UPDATE public.data_sources
    SET
      record_count = (SELECT COUNT(*) FROM public.personas_master),
      last_loaded_at = NOW(),
      last_job_status = 'completed',
      updated_at = NOW()
    WHERE slug = 'master_personas'
  `)

  for (const sql of [
    'SELECT refresh_dashboard_stats()',
    'SELECT refresh_company_name_lookup()',
    'SELECT refresh_persona_scores()',
  ]) {
    try {
      await pgClient.query(sql)
    } catch (error) {
      log(`[warn] no se pudo ejecutar ${sql}: ${error.message}`)
    }
  }

  const checks = [
    ['personas_master_final', 'SELECT COUNT(*)::bigint AS total FROM public.personas_master'],
    ['persona_contact_points_final', 'SELECT COUNT(*)::bigint AS total FROM public.persona_contact_points'],
    ['persona_scores_final', 'SELECT COUNT(*)::bigint AS total FROM public.persona_scores'],
  ]

  for (const [label, sql] of checks) {
    const result = await pgClient.query(sql)
    log(`[apply] ${label}=${result.rows[0]?.total ?? 0}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const pgClient = new Client(resolvePgConfig())

  await pgClient.connect()
  await pgClient.query('SET statement_timeout = 0')
  await pgClient.query('SET lock_timeout = 0')
  await trySet(pgClient, "SET work_mem = '64MB'")
  await trySet(pgClient, "SET maintenance_work_mem = '128MB'")
  await trySet(pgClient, 'SET synchronous_commit = off')

  try {
    await ensureRutHelpers(pgClient)

    if (args.rebuildStage || args.resumeStage || (args.apply && !args.applyExistingStage)) {
      await buildStages(pgClient, { forceRebuild: !args.resumeStage })
    }

    if (args.apply || args.applyExistingStage) {
      await applyRebuild(pgClient)
    }
  } finally {
    await pgClient.end()
  }
}

main().catch(error => {
  console.error(`\nFallo en rebuild-personas-master-canonical: ${error.message}`)
  process.exitCode = 1
})
