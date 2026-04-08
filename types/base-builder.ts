export type BaseBuilderMatchMode = 'rut' | 'razon_social'

export type BaseBuilderFieldKey =
  | 'nombre_completo'
  | 'nombres'
  | 'paterno'
  | 'materno'
  | 'email'
  | 'fono_cel'
  | 'region_canonica'
  | 'comuna_canonica'
  | 'domicilio_region'
  | 'domicilio_comuna'
  | 'razon_social_empresa'
  | 'n_autos'
  | 'n_bienes_raices'
  | 'totalavaluos'
  | 'score_patrimonial'
  | 'cobertura_pct'
  | 'tiene_autos'
  | 'tiene_empresa'
  | 'tiene_bienes_raices'

export interface BaseBuilderFieldDefinition {
  key: BaseBuilderFieldKey
  label: string
  description: string
  category: 'contacto' | 'identidad' | 'ubicacion' | 'patrimonio' | 'actividad'
}

export interface BaseBuilderCoverageItem {
  field: BaseBuilderFieldKey
  label: string
  count: number
  total: number
  matched_total: number
  pct: number
  matched_pct: number
}

export interface BaseBuilderExportRow {
  rut_input: string
  rut_formateado: string
  rutid: string | null
  match_status: 'matched' | 'not_found' | 'invalid' | 'ambiguous'
  [key: string]: string | number | boolean | null
}

export interface BaseBuilderAnalysisResult {
  match_mode: BaseBuilderMatchMode
  match_column: string | null
  valid_input_count: number
  invalid_input_count: number
  requested_count: number
  unique_count: number
  valid_rut_count: number
  invalid_rut_count: number
  duplicate_count: number
  matched_count: number
  unmatched_count: number
  ambiguous_count: number
  match_rate: number
  rut_column: string | null
  original_columns: string[]
  selected_fields: BaseBuilderFieldKey[]
  coverage: BaseBuilderCoverageItem[]
  web_enrichment?: {
    enabled: boolean
    candidates: number
    attempted: number
    from_cache: number
    limited: boolean
    without_result: number
    email_found: number
    phone_found: number
    providers?: {
      brave: number
      duckduckgo: number
      bing: number
      none: number
      error: number
    }
  }
  rows: BaseBuilderExportRow[]
}

export const BASE_BUILDER_FIELDS: BaseBuilderFieldDefinition[] = [
  {
    key: 'nombre_completo',
    label: 'Nombre completo',
    description: 'Nombre consolidado listo para uso comercial.',
    category: 'identidad',
  },
  {
    key: 'nombres',
    label: 'Nombres',
    description: 'Primer nombre o nombres registrados.',
    category: 'identidad',
  },
  {
    key: 'paterno',
    label: 'Apellido paterno',
    description: 'Apellido paterno consolidado.',
    category: 'identidad',
  },
  {
    key: 'materno',
    label: 'Apellido materno',
    description: 'Apellido materno consolidado.',
    category: 'identidad',
  },
  {
    key: 'email',
    label: 'Email',
    description: 'Correo electrónico principal disponible.',
    category: 'contacto',
  },
  {
    key: 'fono_cel',
    label: 'Teléfono celular',
    description: 'Teléfono móvil asociado al RUT.',
    category: 'contacto',
  },
  {
    key: 'region_canonica',
    label: 'Región canónica',
    description: 'Región consolidada y homologada.',
    category: 'ubicacion',
  },
  {
    key: 'comuna_canonica',
    label: 'Comuna canónica',
    description: 'Comuna consolidada y homologada.',
    category: 'ubicacion',
  },
  {
    key: 'domicilio_region',
    label: 'Región domicilio',
    description: 'Región de domicilio tributario.',
    category: 'ubicacion',
  },
  {
    key: 'domicilio_comuna',
    label: 'Comuna domicilio',
    description: 'Comuna de domicilio tributario.',
    category: 'ubicacion',
  },
  {
    key: 'razon_social_empresa',
    label: 'Razón social empresa',
    description: 'Empresa vinculada al RUT cuando existe.',
    category: 'actividad',
  },
  {
    key: 'n_autos',
    label: 'N° autos',
    description: 'Cantidad de vehículos asociados.',
    category: 'patrimonio',
  },
  {
    key: 'n_bienes_raices',
    label: 'N° bienes raíces',
    description: 'Cantidad de propiedades registradas.',
    category: 'patrimonio',
  },
  {
    key: 'totalavaluos',
    label: 'Total avalúos',
    description: 'Suma total de avalúos asociados.',
    category: 'patrimonio',
  },
  {
    key: 'score_patrimonial',
    label: 'Score patrimonial',
    description: 'Puntaje patrimonial calculado.',
    category: 'patrimonio',
  },
  {
    key: 'cobertura_pct',
    label: 'Cobertura datos (%)',
    description: 'Porcentaje interno de cobertura del perfil.',
    category: 'actividad',
  },
  {
    key: 'tiene_autos',
    label: 'Tiene autos',
    description: 'Indicador de tenencia de vehículos.',
    category: 'patrimonio',
  },
  {
    key: 'tiene_empresa',
    label: 'Tiene empresa',
    description: 'Indicador de vínculo empresarial.',
    category: 'actividad',
  },
  {
    key: 'tiene_bienes_raices',
    label: 'Tiene bienes raíces',
    description: 'Indicador de tenencia de propiedades.',
    category: 'patrimonio',
  },
]
