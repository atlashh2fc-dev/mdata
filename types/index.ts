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
  region_canonica?: string | null
  comuna_canonica?: string | null
  created_at: string
  updated_at: string
}

export interface CommercialDashboardSnapshot {
  total_personas_scored: number
  personas_with_feedback: number
  personas_contacted_30d: number
  personas_high_priority: number
  personas_high_purchase_propensity: number
  personas_high_contactability: number
  personas_contact_now: number
  personas_callback_pending: number
  personas_in_cooldown: number
  avg_contactability_score: number
  avg_purchase_propensity_score: number
  avg_priority_score: number
  total_sales_events: number
  total_sales_amount: number
  last_feedback_sync_at: string | null
  refreshed_at: string
}

export interface CommercialScoreSnapshot {
  rutid: string
  nombre_completo: string | null
  region_canonica: string | null
  comuna_canonica: string | null
  best_phone: string | null
  best_email: string | null
  contactability_score: number
  purchase_propensity_score: number
  priority_score: number
  recommended_channel: string
  recommended_hour: number
  next_best_action: string
  total_interactions: number
  interactions_30d: number
  interactions_90d: number
  effective_contacts_total: number
  no_contact_total: number
  callbacks_total: number
  sales_total: number
  sales_amount_total: number
  last_contact_at: string | null
  score_signals: {
    strengths?: string[]
    risks?: string[]
  } | null
  refreshed_at: string
}

export interface ContactCenterFeedbackItem {
  id: string
  gestion_at: string
  channel: string | null
  outcome: string | null
  outcome_subtype: string | null
  outcome_group: string | null
  contact_effective: boolean
  callback_requested: boolean
  mail_opened: boolean
  clicked: boolean
  replied: boolean
  sale: boolean
  sale_amount: number | null
  duration_seconds: number | null
  agent_name: string | null
  campaign_name: string | null
  phone_raw: string | null
  email_raw: string | null
  is_best_management: boolean
  is_high_intent: boolean
}

export interface PersonaContactPoint {
  rutid: string
  contact_type: 'phone' | 'email'
  normalized_value: string
  display_value: string
  last_seen_at: string | null
  usage_count: number
  successful_interactions: number
  from_master: boolean
  rank_in_type: number
}

export interface ContactCenterFeedback {
  id: string
  source_system: string
  source_event_id: string
  source_table?: string | null
  source_record_updated_at?: string | null
  sync_run_id?: string | null
  rutid?: string | null
  phone?: string | null
  normalized_phone?: string | null
  email?: string | null
  normalized_email?: string | null
  channel: string
  direction: string
  event_at: string
  outcome: string
  outcome_subtype?: string | null
  contact_status?: string | null
  is_contact: boolean
  is_effective_contact: boolean
  is_interested: boolean
  callback_requested: boolean
  sale_closed: boolean
  mail_opened: boolean
  mail_clicked: boolean
  response_received: boolean
  is_best_management: boolean
  duration_seconds?: number | null
  agent_id?: string | null
  agent_name?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  offer_name?: string | null
  rejection_reason?: string | null
  monetary_value?: number | null
  management_score?: number | null
  notes?: string | null
  raw_payload: Record<string, unknown>
  derived_signals: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface PersonaFeedbackFeatures {
  rutid: string
  total_feedback_events: number
  contact_attempts: number
  effective_contacts: number
  positive_outcomes: number
  negative_outcomes: number
  callback_requests: number
  interested_events: number
  sales_events: number
  email_open_events: number
  email_click_events: number
  response_events: number
  best_management_events: number
  unique_channels: number
  unique_agents: number
  unique_campaigns: number
  unique_phones_contacted: number
  unique_emails_contacted: number
  avg_duration_seconds?: number | null
  total_monetary_value: number
  contact_rate: number
  effective_contact_rate: number
  purchase_rate: number
  email_open_rate: number
  email_click_rate: number
  response_rate: number
  callback_rate: number
  negative_rate: number
  best_channel?: string | null
  best_hour_local?: number | null
  best_phone?: string | null
  best_email?: string | null
  last_event_at?: string | null
  last_contact_at?: string | null
  last_effective_contact_at?: string | null
  last_positive_event_at?: string | null
  last_sale_at?: string | null
  last_negative_event_at?: string | null
  channel_breakdown: Record<string, unknown>
  outcome_breakdown: Record<string, unknown>
  top_signals: string[]
  updated_at: string
}

export interface PersonaScore {
  rutid: string
  contactability_score: number
  purchase_propensity_score: number
  commercial_priority_score: number
  priority_tier: string
  best_channel?: string | null
  best_hour_local?: number | null
  best_phone?: string | null
  best_email?: string | null
  recommended_action: string
  recommended_strategy: Record<string, unknown>
  score_inputs: Record<string, unknown>
  score_signals: string[]
  explanation: Record<string, unknown>
  model_type: string
  model_version: string
  last_scored_at: string
  updated_at: string
}

export interface PersonaIntelligence extends PersonaView {
  contactability_score: number
  purchase_propensity_score: number
  commercial_priority_score: number
  priority_tier: string
  best_channel?: string | null
  best_hour_local?: number | null
  best_phone?: string | null
  best_email?: string | null
  recommended_action?: string | null
  recommended_strategy?: Record<string, unknown> | null
  score_inputs?: Record<string, unknown> | null
  score_signals?: string[] | null
  explanation?: Record<string, unknown> | null
  model_type?: string | null
  model_version?: string | null
  last_scored_at?: string | null
  total_feedback_events: number
  contact_attempts: number
  effective_contacts: number
  sales_events: number
  email_open_events: number
  email_click_events: number
  callback_requests: number
  contact_rate?: number | null
  effective_contact_rate?: number | null
  purchase_rate?: number | null
  email_open_rate?: number | null
  email_click_rate?: number | null
  response_rate?: number | null
  callback_rate?: number | null
  negative_rate?: number | null
  learned_best_channel?: string | null
  learned_best_hour_local?: number | null
  learned_best_phone?: string | null
  learned_best_email?: string | null
  last_event_at?: string | null
  last_contact_at?: string | null
  last_effective_contact_at?: string | null
  last_positive_event_at?: string | null
  last_sale_at?: string | null
  last_negative_event_at?: string | null
  channel_breakdown?: Record<string, unknown> | null
  outcome_breakdown?: Record<string, unknown> | null
  top_signals?: string[] | null
}

export interface IntelligenceDashboardStats {
  scored_personas: number
  personas_with_feedback: number
  avg_contactability_score: number
  avg_purchase_propensity_score: number
  avg_priority_score: number
  p1_count: number
  p2_count: number
  p3_count: number
  p4_count: number
  generated_at: string
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
  total_propiedades_cargadas: number
  empresas_universo_total: number
  empresas_base_pyme: number
  empresas_base_tendencia: number
  empresas_cruzadas: number
  empresas_solo_pyme_master: number
  empresas_solo_tendencia: number
  empresas_con_direccion: number
  empresas_con_comuna: number
  empresas_con_region: number
  empresas_pyme: number
  empresas_grandes: number
  empresas_corporacion: number
  empresas_segmento_micro: number
  empresas_segmento_micro_sube: number
  empresas_segmento_micro_baja: number
  empresas_segmento_pequena: number
  empresas_segmento_pequena_sube: number
  empresas_segmento_pequena_baja: number
  empresas_segmento_mediana: number
  empresas_segmento_mediana_sube: number
  empresas_segmento_mediana_baja: number
  empresas_segmento_gran_empresa: number
  empresas_segmento_gran_empresa_sube: number
  empresas_segmento_gran_empresa_baja: number
  empresas_segmento_corporacion: number
  empresas_segmento_corporacion_sube: number
  empresas_segmento_corporacion_baja: number
  empresas_segmento_pyme_master_sin_tramo: number
  empresas_segmento_pyme_master_sin_tramo_sube: number
  empresas_segmento_pyme_master_sin_tramo_baja: number
  empresas_tendencia_total: number
  empresas_tendencia_sube: number
  empresas_tendencia_baja: number
  empresas_tendencia_estable: number
  empresas_tendencia_sin_datos: number
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

export type AIAnalysisType =
  | 'enrichment'
  | 'classification'
  | 'scoring'
  | 'dataset'
  | 'campaign_strategy'

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

// ============================================================
// COMMERCIAL INTELLIGENCE TYPES
// ============================================================

export type FeedbackChannel =
  | 'phone'
  | 'email'
  | 'whatsapp'
  | 'sms'
  | 'bot'
  | 'web'
  | 'in_person'
  | 'other'

export type FeedbackOutcome =
  | 'contacted'
  | 'no_contact'
  | 'interested'
  | 'callback'
  | 'rejected'
  | 'sale'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'do_not_contact'
  | 'unknown'

export interface ContactCenterFeedbackInput {
  id?: string
  external_source?: string
  external_event_id?: string
  external_record_type?: string
  rutid?: string | null
  matched_rutid?: string | null
  match_method?: string | null
  contact_phone?: string | null
  telefono?: string | null
  contact_email?: string | null
  email?: string | null
  channel?: FeedbackChannel
  managed_at?: string | Date | null
  fecha_gestion?: string | Date | null
  created_at?: string | Date | null
  outcome?: FeedbackOutcome
  outcome_subtype?: string | null
  outcome_reason?: string | null
  motivo_rechazo?: string | null
  direction?: string | null
  duration_seconds?: number | null
  duracion?: number | null
  talk_seconds?: number | null
  wait_seconds?: number | null
  agent_id?: string | null
  agent_name?: string | null
  agente?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  campana?: string | null
  opened_at?: string | Date | null
  clicked_at?: string | Date | null
  callback_at?: string | Date | null
  responded_at?: string | Date | null
  sold_at?: string | Date | null
  value_amount?: number | null
  monto?: number | null
  mail_opened?: boolean | number | string | null
  clicked?: boolean | number | string | null
  callback_requested?: boolean | number | string | null
  callback?: boolean | number | string | null
  interested?: boolean | number | string | null
  contacted?: boolean | number | string | null
  effective_contact?: boolean | number | string | null
  sale?: boolean | number | string | null
  venta?: boolean | number | string | null
  is_best_management?: boolean | number | string | null
  raw_payload?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface PersonaFeedbackEvent {
  id: string
  external_source: string
  external_event_id: string
  rutid: string | null
  matched_rutid: string | null
  contact_phone: string | null
  contact_email: string | null
  channel: FeedbackChannel
  managed_at: string
  outcome: FeedbackOutcome
  outcome_subtype: string | null
  outcome_reason: string | null
  duration_seconds: number | null
  agent_name: string | null
  campaign_name: string | null
  mail_opened: boolean
  clicked: boolean
  callback_requested: boolean
  interested: boolean
  effective_contact: boolean
  sale: boolean
  is_best_management: boolean
  value_amount: number | null
  raw_payload: Record<string, unknown>
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface PersonaScoreCard {
  rutid: string
  contactability_score: number
  purchase_propensity_score: number
  priority_score: number
  best_channel: FeedbackChannel
  best_contact_hour: number | null
  best_phone: string | null
  best_email: string | null
  next_best_action: string
  action_priority: string
  should_contact: boolean
  total_interactions: number
  effective_contacts: number
  no_contact_events: number
  interest_events: number
  callback_events: number
  sales_events: number
  opened_events: number
  clicked_events: number
  best_management_events: number
  known_phone_count: number
  known_email_count: number
  last_contact_at: string | null
  last_sale_at: string | null
  last_feedback_at: string | null
  feedback_coverage: boolean
  signal_summary: Record<string, unknown>
  updated_at: string
}

export interface CommercialRutSummary {
  rutid: string
  feedback_coverage: boolean
  should_contact: boolean
  contactability_score: number
  purchase_propensity_score: number
  priority_score: number
  best_channel: FeedbackChannel | null
  best_contact_hour: number | null
  next_best_action: string | null
  action_priority: string | null
  best_phone: string | null
  best_email: string | null
  total_interactions: number
  effective_contacts: number
  interest_events: number
  callback_events: number
  sales_events: number
  latest_outcome: FeedbackOutcome | null
  latest_outcome_subtype: string | null
  latest_channel: FeedbackChannel | null
  latest_campaign_name: string | null
  latest_agent_name: string | null
  latest_managed_at: string | null
  last_contact_at: string | null
  last_sale_at: string | null
  last_feedback_at: string | null
  updated_at: string | null
}

export interface ContactPoint {
  id: string
  rutid: string
  contact_type: 'phone' | 'email'
  contact_value: string
  normalized_value: string
  source_name: string
  source_priority: number
  quality_score: number
  is_primary: boolean
  is_verified: boolean
  is_deliverable: boolean | null
  first_seen_at: string
  last_seen_at: string
  last_feedback_at: string | null
  metadata: Record<string, unknown>
}

export interface PersonaCommercialIntelligence {
  persona: PersonaView
  score: PersonaScoreCard | null
  history: PersonaFeedbackEvent[]
  contact_points: ContactPoint[]
}

export interface CommercialOverview {
  total_scored_personas: number
  with_feedback: number
  high_priority_personas: number
  recommended_phone: number
  recommended_email: number
  avg_contactability_score: number
  avg_purchase_propensity_score: number
  avg_priority_score: number
  last_score_refresh: string | null
  last_feedback_sync: string | null
  top_opportunities: PersonaScoreCard[]
  recent_syncs: Record<string, unknown>[]
}

export interface ContactCenterIngestionResult {
  inserted: number
  affected_ruts: number
  refreshed_scores: number
  sync_run_id: string | null
}

export type CampaignSeverity = 'healthy' | 'watch' | 'risk' | 'critical'

export interface CommercialHealthSnapshot {
  overall_health_score: number
  active_campaigns: number
  campaigns_at_risk: number
  critical_campaigns: number
  anomaly_count: number
  current_contact_rate: number
  expected_contact_rate: number
  current_conversion_rate: number
  expected_conversion_rate: number
  current_interest_rate: number
  expected_interest_rate: number
  monitored_window_hours: number
  last_feedback_at: string | null
}

export interface CampaignHealthCard {
  campaign_name: string
  attempts_3h: number
  unique_leads_3h: number
  effective_contacts_3h: number
  sales_3h: number
  interest_3h: number
  current_contact_rate: number
  baseline_contact_rate: number
  current_conversion_rate: number
  baseline_conversion_rate: number
  current_interest_rate: number
  baseline_interest_rate: number
  fatigue_score: number
  health_score: number
  severity: CampaignSeverity
  underperformance_hours: number
  probable_causes: string[]
  recommended_action: string
  recommended_adjustments: string[]
  top_channel: string | null
  best_next_window: string
  ai_summary: string | null
  supporting_signals: Record<string, unknown>
}

export interface TacticalRecommendation {
  title: string
  scope: 'campaign' | 'segment' | 'window' | 'portfolio'
  rationale: string
  action: string
  impact: string
  priority: 'high' | 'medium' | 'low'
}

export interface SegmentHealthInsight {
  segment_label: string
  segment_type: 'region' | 'comuna' | 'channel' | 'cohort'
  volume: number
  current_contact_rate: number
  baseline_contact_rate: number
  current_conversion_rate: number
  baseline_conversion_rate: number
  health_delta: number
  recommendation: string
}

export interface WindowPerformance {
  hour: number
  label: string
  attempts: number
  contact_rate: number
  conversion_rate: number
  interest_rate: number
  score: number
  recommendation: string
}

export interface LeadActionItem {
  rutid: string
  nombre_completo: string | null
  campaign_name: string | null
  region: string | null
  comuna: string | null
  priority_score: number
  dynamic_priority_score: number
  contact_probability: number
  conversion_probability: number
  fatigue_score: number
  operational_affinity: number
  optimal_window: string
  recommended_channel: string
  next_best_action: string
  reason_tags: string[]
}

export interface CommercialBrainOverview {
  snapshot: CommercialHealthSnapshot
  campaigns: CampaignHealthCard[]
  recommendations: TacticalRecommendation[]
  strong_segments: SegmentHealthInsight[]
  weak_segments: SegmentHealthInsight[]
  optimal_windows: WindowPerformance[]
  lead_actions: LeadActionItem[]
  ai_executive_summary: string | null
  generated_at: string
}

export interface CampaignActionInstruction {
  campaign_name: string
  severity: CampaignSeverity
  health_score: number
  underperformance_hours: number
  recommended_action: string
  recommended_adjustments: string[]
  best_next_window: string
  top_channel: string | null
  probable_causes: string[]
}

export interface LeadActionInstruction {
  rutid: string
  campaign_name: string | null
  dynamic_priority_score: number
  contact_probability: number
  conversion_probability: number
  fatigue_score: number
  optimal_window: string
  recommended_channel: string
  next_best_action: string
  reason_tags: string[]
}

export interface CommercialActionFeed {
  source_system: string
  generated_at: string
  portfolio_status: {
    overall_health_score: number
    campaigns_at_risk: number
    critical_campaigns: number
    anomaly_count: number
  }
  executive_summary: string | null
  campaign_instructions: CampaignActionInstruction[]
  lead_instructions: LeadActionInstruction[]
  recommendations: TacticalRecommendation[]
}

export type MiroFishScenarioScope = 'commercial_brain' | 'portfolio' | 'equifax'

export type MiroFishScenarioLifecycleStatus =
  | 'draft'
  | 'running'
  | 'completed'
  | 'failed'

export type MiroFishScenarioPhase =
  | 'pack_built'
  | 'graph_building'
  | 'graph_ready'
  | 'simulation_created'
  | 'simulation_preparing'
  | 'simulation_ready'
  | 'simulation_running'
  | 'simulation_completed'
  | 'report_generating'
  | 'report_ready'

export interface MiroFishScenarioRun {
  id: string
  title: string
  scenario_scope: MiroFishScenarioScope
  status: MiroFishScenarioLifecycleStatus
  phase: MiroFishScenarioPhase
  simulation_requirement: string
  hypothesis: string | null
  additional_context: string | null
  scenario_pack_markdown: string
  source_payload: Record<string, unknown>
  remote_project_id: string | null
  remote_graph_id: string | null
  remote_graph_task_id: string | null
  remote_simulation_id: string | null
  remote_prepare_task_id: string | null
  remote_report_task_id: string | null
  remote_report_id: string | null
  remote_status_payload: Record<string, unknown>
  report_markdown: string | null
  report_summary: string | null
  last_error: string | null
  created_by: string | null
  started_at: string
  completed_at: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export interface MiroFishScenarioStartRequest {
  title: string
  hypothesis: string
  simulation_requirement?: string | null
  additional_context?: string | null
  scope?: MiroFishScenarioScope
  include_equifax_projection?: boolean
  equifax_generation_params?: Record<string, unknown> | null
  max_rounds?: number | null
}
