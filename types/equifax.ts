export interface EquifaxSalesImportResult {
  inserted: number
  updated: number
  total_rows: number
  sheets: string[]
}

export interface EquifaxProductCatalogItem {
  id: string
  name: string
  category: string | null
  description: string | null
  target_rubro: string | null
  target_company_keywords: string[]
  pain_points: string[]
  pricing_notes: string | null
  filters: Record<string, unknown>
  raw_payload: Record<string, unknown>
  is_active: boolean
  created_at: string
}

export interface EquifaxCatalogSummary {
  total_sales: number
  total_customers: number
  recurrent_sales: number
  one_time_sales: number
  total_products: number
  last_sale_at: string | null
  top_services: Array<{
    service: string
    count: number
    total_amount: number
  }>
}

export interface EquifaxLeadGenerationParams {
  volume: number
  product_ids?: string[]
  transient_products?: Array<Record<string, unknown>>
  prompt?: string | null
  regions?: string[]
  include_existing_customers?: boolean
  min_phone_count?: number
  min_email_count?: number
  scenario_key?: string | null
}

export interface EquifaxLeadResultItem {
  rutid: string
  company_name: string
  region: string | null
  comuna: string | null
  best_phone: string | null
  best_email: string | null
  phone_count: number
  email_count: number
  contactability_score: number
  purchase_propensity_score: number
  equifax_fit_score: number
  priority_score: number
  contact_probability: number
  interest_probability: number
  purchase_probability: number
  lead_score: number
  lead_temperature: 'green' | 'yellow' | 'red'
  recommended_channel: string | null
  recommended_hour: number | null
  is_existing_customer: boolean
  last_equifax_sale_at: string | null
  services_bought: string[]
  reason_tags: string[]
}

export interface EquifaxLeadGenerationResult {
  run_id: string
  scenario_key: string
  scenario_title: string
  generated_count: number
  requested_volume: number
  ai_profile: Record<string, unknown>
  summary: {
    existing_customers: number
    prospects: number
    avg_priority_score: number
    avg_contactability_score: number
    avg_purchase_propensity_score: number
    avg_equifax_fit_score: number
    green_leads: number
    yellow_leads: number
    red_leads: number
  }
  rows: EquifaxLeadResultItem[]
}

export interface EquifaxLeadScenario {
  key: string
  title: string
  description: string
  recommendation: string
  generated_count: number
  requested_volume: number
  summary: {
    existing_customers: number
    prospects: number
    avg_priority_score: number
    avg_contactability_score: number
    avg_purchase_propensity_score: number
    avg_equifax_fit_score: number
    green_leads: number
    yellow_leads: number
    red_leads: number
  }
  highlights: string[]
  sample_rows: EquifaxLeadResultItem[]
}

export interface EquifaxLeadPreviewResult {
  requested_volume: number
  universe_analyzed: number
  eligible_matches: number
  recommended_scenario_key: string
  ai_profile: Record<string, unknown>
  scenarios: EquifaxLeadScenario[]
}

export interface EquifaxLeadFeatureSnapshot {
  rutid: string
  company_name: string | null
  region: string | null
  comuna: string | null
  is_existing_customer: boolean
  equifax_sales_count: number
  equifax_recurrent_sales_count: number
  equifax_one_time_sales_count: number
  equifax_total_amount: number
  known_phone_count: number
  known_email_count: number
  feedback_total_interactions: number
  feedback_equifax_interactions: number
  effective_contacts: number
  no_contact_events: number
  interest_events: number
  callback_events: number
  sales_events: number
  opened_events: number
  clicked_events: number
  best_management_events: number
  contact_rate: number
  interest_rate: number
  callback_rate: number
  sale_rate: number
  no_contact_rate: number
  best_channel: string | null
  best_contact_hour: number | null
  feature_payload: Record<string, unknown>
  label_contact: boolean
  label_interest: boolean
  label_purchase: boolean
  refreshed_at: string
}

export interface EquifaxLeadScoreSnapshot {
  rutid: string
  model_version: string
  model_type: string
  contact_probability: number
  interest_probability: number
  purchase_probability: number
  lead_score: number
  lead_temperature: 'green' | 'yellow' | 'red'
  fit_score: number
  recommended_channel: string | null
  recommended_hour: number | null
  reason_tags: string[]
  score_breakdown: Record<string, unknown>
  scored_at: string
}
