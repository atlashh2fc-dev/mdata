// ============================================================
// CORE DOMAIN TYPES
// ============================================================

export interface MasterPersona {
  rutid: string
  created_at: string
  updated_at: string
}

export interface PernatResumen {
  id: string
  rutid: string
  nombres: string | null
  paterno: string | null
  materno: string | null
  email: string | null
  fono_cel: string | null
  comuna_part: string | null
  region_part: string | null
  created_at: string
  updated_at: string
}

export interface AutosResumen {
  id: string
  rutid: string
  n_autos: number
  created_at: string
  updated_at: string
}

export interface EmpresaResumen {
  id: string
  rutid: string
  razon_social_empresa: string | null
  created_at: string
  updated_at: string
}

export interface DomicilioResumen {
  id: string
  rutid: string
  comuna: string | null
  region: string | null
  created_at: string
  updated_at: string
}

export interface AcumuladoResumen {
  id: string
  rutid: string
  n_bienes_raices: number
  totalavaluos: number
  created_at: string
  updated_at: string
}

// Vista consolidada 360°
export interface PersonaView {
  rutid: string
  nombres: string | null
  paterno: string | null
  materno: string | null
  nombre_completo: string | null
  email: string | null
  fono_cel: string | null
  comuna_part: string | null
  region_part: string | null
  n_autos: number
  tiene_autos: boolean
  razon_social_empresa: string | null
  tiene_empresa: boolean
  domicilio_comuna: string | null
  domicilio_region: string | null
  n_bienes_raices: number
  totalavaluos: number
  tiene_bienes_raices: boolean
  score_patrimonial: number
  cobertura_pct: number
  created_at: string
  updated_at: string
}

// ============================================================
// DASHBOARD TYPES
// ============================================================

export interface DashboardStats {
  total_ruts: number
  con_nombre: number
  con_email: number
  con_fono: number
  con_autos: number
  total_autos: number
  con_empresa: number
  con_domicilio: number
  con_bienes_raices: number
  total_avaluos: number
  jobs_completados: number
  jobs_fallidos: number
  total_segmentos: number
  last_refreshed: string
}

export interface KPICard {
  title: string
  value: number | string
  change?: number
  changeLabel?: string
  trend?: 'up' | 'down' | 'neutral'
  icon?: string
  format?: 'number' | 'percentage' | 'currency' | 'text'
}

export interface CoberturaItem {
  field: string
  label: string
  count: number
  total: number
  pct: number
}

// ============================================================
// INGESTION TYPES
// ============================================================

export type IngestionStatus =
  | 'pending'
  | 'processing'
  | 'validating'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SourceType = 'csv' | 'xlsx' | 'json' | 'api' | 'mysql' | 'postgres'

export interface DataSource {
  id: string
  name: string
  slug?: string | null
  description: string | null
  source_type: SourceType
  is_active: boolean
  config: Record<string, unknown>
  canonical_table?: string | null
  source_table_name?: string | null
  primary_key_column?: string | null
  supports_incremental?: boolean
  record_count?: number
  coverage_pct?: number | null
  last_loaded_at?: string | null
  last_job_status?: string | null
  last_error_message?: string | null
  latest_version_id?: string | null
  latest_version_label?: string | null
  latest_load_mode?: string | null
  latest_source_row_count?: number | null
  latest_loaded_row_count?: number | null
  latest_new_rows?: number | null
  latest_updated_rows?: number | null
  latest_failed_rows?: number | null
  latest_version_status?: string | null
  latest_version_completed_at?: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface SourceVersion {
  id: string
  source_id: string
  version_label: string
  load_mode: string
  source_row_count: number
  loaded_row_count: number
  new_rows: number
  updated_rows: number
  failed_rows: number
  checksum: string | null
  source_snapshot_at: string | null
  started_at: string
  completed_at: string | null
  status: string
  notes: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface IngestionJob {
  id: string
  source_id: string | null
  file_name: string | null
  file_size: number | null
  file_path: string | null
  status: IngestionStatus
  total_rows: number
  valid_rows: number
  invalid_rows: number
  merged_rows: number
  new_rows: number
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  // joins
  data_source?: DataSource
}

export interface IngestionLog {
  id: string
  job_id: string
  level: 'info' | 'warn' | 'error'
  message: string
  row_number: number | null
  raw_data: Record<string, unknown> | null
  created_at: string
}

export interface SourceColumnMapping {
  id: string
  source_id: string
  source_column: string
  target_table: string
  target_column: string
  transform_fn: string | null
  is_rut_column: boolean
  is_required: boolean
  created_at: string
  updated_at: string
}

export interface MergeRule {
  id: string
  source_id: string
  target_table: string
  on_conflict: 'update' | 'skip' | 'append'
  condition_sql: string | null
  priority: number
  is_active: boolean
  created_at: string
}

export interface StagingRow {
  id: string
  job_id: string
  row_number: number
  raw_data: Record<string, unknown>
  mapped_data: Record<string, unknown> | null
  rutid: string | null
  is_valid_rut: boolean | null
  validation_errors: string[]
  status: 'pending' | 'valid' | 'invalid' | 'merged'
  created_at: string
}

// ============================================================
// COLUMN DETECTION
// ============================================================

export interface DetectedColumn {
  name: string
  sample_values: string[]
  inferred_type: 'text' | 'number' | 'date' | 'boolean' | 'rut'
  null_pct: number
  unique_count: number
}

export interface ColumnMappingDraft {
  source_column: string
  target_table: string | null
  target_column: string | null
  transform_fn: string | null
  is_rut_column: boolean
  sample_values: string[]
  inferred_type: string
}

// ============================================================
// SEGMENTOS TYPES
// ============================================================

export interface FilterCondition {
  field: string
  operator: FilterOperator
  value: string | number | boolean | null
  value2?: string | number | null // para BETWEEN
}

export type FilterOperator =
  | 'eq' | 'neq'
  | 'gt' | 'gte'
  | 'lt' | 'lte'
  | 'between'
  | 'in' | 'not_in'
  | 'is_null' | 'is_not_null'
  | 'contains' | 'starts_with'

export type FilterLogic = 'AND' | 'OR'

export interface SegmentFilter {
  logic: FilterLogic
  conditions: FilterCondition[]
}

export interface Segmento {
  id: string
  name: string
  description: string | null
  filters: SegmentFilter
  sql_query: string | null
  row_count: number
  last_computed: string | null
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface SegmentExport {
  id: string
  segment_id: string
  file_name: string | null
  file_path: string | null
  file_size: number | null
  row_count: number | null
  format: 'csv' | 'xlsx'
  status: 'pending' | 'processing' | 'completed' | 'failed'
  created_by: string | null
  created_at: string
  completed_at: string | null
}

// ============================================================
// AI TYPES
// ============================================================

export type AIAnalysisType = 'enrichment' | 'classification' | 'scoring' | 'dataset'

export interface AIAnalysisRequest {
  type: AIAnalysisType
  data: Record<string, unknown>
  context?: string
}

export interface AIAnalysisResponse {
  type: AIAnalysisType
  result: Record<string, unknown>
  confidence?: number
  model: string
  tokens_used: number
  duration_ms: number
}

export interface AIAnalysisLog {
  id: string
  analysis_type: AIAnalysisType
  input_data: Record<string, unknown> | null
  output_data: Record<string, unknown> | null
  model: string
  tokens_used: number | null
  duration_ms: number | null
  created_by: string | null
  created_at: string
}

// ============================================================
// API RESPONSE TYPES
// ============================================================

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// ============================================================
// QUERY PARAMS
// ============================================================

export interface SearchParams {
  q?: string
  page?: number
  page_size?: number
  sort_by?: string
  sort_order?: 'asc' | 'desc'
}

export interface PersonaSearchParams extends SearchParams {
  region?: string
  comuna?: string
  tiene_autos?: boolean
  tiene_empresa?: boolean
  tiene_bienes_raices?: boolean
  score_min?: number
  score_max?: number
}

// ============================================================
// AVAILABLE FILTER FIELDS
// ============================================================

export interface FilterField {
  key: keyof PersonaView
  label: string
  type: 'text' | 'number' | 'boolean' | 'select'
  options?: { value: string; label: string }[]
}

export const FILTER_FIELDS: FilterField[] = [
  { key: 'region_part', label: 'Región (pernat)', type: 'text' },
  { key: 'domicilio_region', label: 'Región (domicilio)', type: 'text' },
  { key: 'comuna_part', label: 'Comuna (pernat)', type: 'text' },
  { key: 'domicilio_comuna', label: 'Comuna (domicilio)', type: 'text' },
  { key: 'n_autos', label: 'N° Autos', type: 'number' },
  { key: 'tiene_autos', label: 'Tiene autos', type: 'boolean' },
  { key: 'tiene_empresa', label: 'Tiene empresa', type: 'boolean' },
  { key: 'tiene_bienes_raices', label: 'Tiene bienes raíces', type: 'boolean' },
  { key: 'n_bienes_raices', label: 'N° Bienes raíces', type: 'number' },
  { key: 'totalavaluos', label: 'Total avalúos ($)', type: 'number' },
  { key: 'score_patrimonial', label: 'Score patrimonial', type: 'number' },
  { key: 'cobertura_pct', label: 'Cobertura datos (%)', type: 'number' },
]

// ============================================================
// TARGET TABLE COLUMNS (for column mapping)
// ============================================================

export const TARGET_COLUMNS: Record<string, { column: string; label: string }[]> = {
  pernat_resumen: [
    { column: 'nombres', label: 'Nombres' },
    { column: 'paterno', label: 'Apellido paterno' },
    { column: 'materno', label: 'Apellido materno' },
    { column: 'email', label: 'Email' },
    { column: 'fono_cel', label: 'Teléfono celular' },
    { column: 'comuna_part', label: 'Comuna' },
    { column: 'region_part', label: 'Región' },
  ],
  autos_resumen: [
    { column: 'n_autos', label: 'N° de autos' },
  ],
  empresa_resumen: [
    { column: 'razon_social_empresa', label: 'Razón social empresa' },
  ],
  domicilio_resumen: [
    { column: 'comuna', label: 'Comuna domicilio' },
    { column: 'region', label: 'Región domicilio' },
  ],
  acumulado_resumen: [
    { column: 'n_bienes_raices', label: 'N° bienes raíces' },
    { column: 'totalavaluos', label: 'Total avalúos' },
  ],
}
