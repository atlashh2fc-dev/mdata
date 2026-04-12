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
  is_existing_customer: boolean
  last_equifax_sale_at: string | null
  services_bought: string[]
  reason_tags: string[]
}

export interface EquifaxLeadGenerationResult {
  run_id: string
  generated_count: number
  requested_volume: number
  ai_profile: Record<string, unknown>
  summary: {
    existing_customers: number
    prospects: number
    avg_priority_score: number
    avg_contactability_score: number
    avg_purchase_propensity_score: number
  }
  rows: EquifaxLeadResultItem[]
}
