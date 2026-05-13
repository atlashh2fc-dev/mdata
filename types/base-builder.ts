export type BaseBuilderMatchMode = 'rut' | 'nombre_persona' | 'razon_social'

export type BaseBuilderFieldKey =
  | 'nombre_completo'
  | 'nombres'
  | 'paterno'
  | 'materno'
  | 'email'
  | 'fono_cel'
  | 'email_fuente'
  | 'fono_cel_fuente'
  | 'email_verificado'
  | 'fono_cel_verificado'
  | 'email_quality_score'
  | 'fono_cel_quality_score'
  | 'region_canonica'
  | 'comuna_canonica'
  | 'domicilio_region'
  | 'domicilio_comuna'
  | 'razon_social_empresa'
  | 'rubro'
  | 'facturacion_sub_rango'
  | 'tamano_empresas'
  | 'fecha_direccion_comer'
  | 'con_cargo_ejecutivo'
  | 'con_email_ejecutivo'
  | 'con_fono_celular_ejecutivo'
  | 'con_fono_comercial_ejecutivo'
  | 'ejecutivo_nombre'
  | 'ejecutivo_cargo'
  | 'ejecutivo_area'
  | 'ejecutivo_email'
  | 'ejecutivo_telefono'
  | 'ejecutivo_rutid'
  | 'ejecutivo_contact_priority'
  | 'n_autos'
  | 'n_bienes_raices'
  | 'totalavaluos'
  | 'uso_propiedad_inferido'
  | 'bbrr_destinos'
  | 'n_propiedades_detalle'
  | 'n_propiedades_residenciales'
  | 'n_propiedades_comerciales'
  | 'n_propiedades_rurales'
  | 'n_propiedades_indeterminadas'
  | 'avaluo_residencial'
  | 'avaluo_comercial'
  | 'avaluo_rural'
  | 'avaluo_indeterminado'
  | 'score_patrimonial'
  | 'cobertura_pct'
  | 'equifax_lead_score'
  | 'equifax_lead_temperature'
  | 'equifax_contact_probability'
  | 'equifax_interest_probability'
  | 'equifax_purchase_probability'
  | 'equifax_fit_score'
  | 'equifax_recommended_channel'
  | 'equifax_recommended_hour'
  | 'equifax_scored_at'
  | 'equifax_reason_tags'
  | 'ventas_anio_ultimo'
  | 'ventas_resultado_tendencia'
  | 'ventas_ultimo_tramo'
  | 'ventas_tramo_promedio'
  | 'ventas_cambio_promedio_anual'
  | 'ventas_pendiente_tendencia'
  | 'ventas_movimientos_alza'
  | 'ventas_movimientos_baja'
  | 'ventas_trabajadores_2024'
  | 'ventas_rubro_economico'
  | 'ventas_subrubro_economico'
  | 'ventas_actividad_economica'
  | 'ventas_region'
  | 'ventas_comuna'
  | 'wom_nombre'
  | 'wom_direccion'
  | 'wom_comuna'
  | 'wom_lineas'
  | 'wom_valor'
  | 'wom_ciclo'
  | 'blacklist_phone_count'
  | 'blacklist_email_count'
  | 'blacklist_last_seen_at'
  | 'blacklist_reasons'
  | 'tiene_autos'
  | 'tiene_empresa'
  | 'tiene_bienes_raices'

export interface BaseBuilderFieldDefinition {
  key: BaseBuilderFieldKey
  label: string
  description: string
  category: 'contacto' | 'identidad' | 'ubicacion' | 'patrimonio' | 'actividad' | 'scoring' | 'riesgo'
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

export type BaseBuilderWebEnrichmentResult = NonNullable<BaseBuilderAnalysisResult['web_enrichment']>

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
    key: 'email_fuente',
    label: 'Fuente email',
    description: 'Origen del mejor email disponible.',
    category: 'contacto',
  },
  {
    key: 'fono_cel_fuente',
    label: 'Fuente teléfono',
    description: 'Origen del mejor teléfono disponible.',
    category: 'contacto',
  },
  {
    key: 'email_verificado',
    label: 'Email verificado',
    description: 'Indica si el email viene marcado como verificado.',
    category: 'contacto',
  },
  {
    key: 'fono_cel_verificado',
    label: 'Teléfono verificado',
    description: 'Indica si el teléfono viene marcado como verificado.',
    category: 'contacto',
  },
  {
    key: 'email_quality_score',
    label: 'Calidad email',
    description: 'Puntaje interno de calidad del email.',
    category: 'contacto',
  },
  {
    key: 'fono_cel_quality_score',
    label: 'Calidad teléfono',
    description: 'Puntaje interno de calidad del teléfono.',
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
    key: 'rubro',
    label: 'Rubro',
    description: 'Rubro comercial asociado a la empresa.',
    category: 'actividad',
  },
  {
    key: 'facturacion_sub_rango',
    label: 'Facturación',
    description: 'Sub-rango de facturación informado para la empresa.',
    category: 'actividad',
  },
  {
    key: 'tamano_empresas',
    label: 'Tamaño empresa',
    description: 'Tamaño comercial de la empresa.',
    category: 'actividad',
  },
  {
    key: 'fecha_direccion_comer',
    label: 'Fecha dirección comercial',
    description: 'Fecha de dirección comercial informada por GEIMSER.',
    category: 'actividad',
  },
  {
    key: 'con_cargo_ejecutivo',
    label: 'Tiene cargo ejecutivo',
    description: 'Flag GEIMSER de cargo ejecutivo disponible.',
    category: 'actividad',
  },
  {
    key: 'con_email_ejecutivo',
    label: 'Tiene email ejecutivo',
    description: 'Flag GEIMSER de email ejecutivo disponible.',
    category: 'actividad',
  },
  {
    key: 'con_fono_celular_ejecutivo',
    label: 'Tiene celular ejecutivo',
    description: 'Flag GEIMSER de celular ejecutivo disponible.',
    category: 'actividad',
  },
  {
    key: 'con_fono_comercial_ejecutivo',
    label: 'Tiene teléfono comercial ejecutivo',
    description: 'Flag GEIMSER de teléfono comercial ejecutivo disponible.',
    category: 'actividad',
  },
  {
    key: 'ejecutivo_nombre',
    label: 'Ejecutivo nombre',
    description: 'Mejor contacto ejecutivo asociado a la empresa.',
    category: 'actividad',
  },
  {
    key: 'ejecutivo_cargo',
    label: 'Ejecutivo cargo',
    description: 'Cargo del mejor contacto ejecutivo.',
    category: 'actividad',
  },
  {
    key: 'ejecutivo_area',
    label: 'Ejecutivo área',
    description: 'Área del mejor contacto ejecutivo.',
    category: 'actividad',
  },
  {
    key: 'ejecutivo_email',
    label: 'Ejecutivo email',
    description: 'Email del mejor contacto ejecutivo.',
    category: 'actividad',
  },
  {
    key: 'ejecutivo_telefono',
    label: 'Ejecutivo teléfono',
    description: 'Mejor teléfono del contacto ejecutivo.',
    category: 'actividad',
  },
  {
    key: 'ejecutivo_rutid',
    label: 'Ejecutivo RUT',
    description: 'RUT del contacto ejecutivo.',
    category: 'actividad',
  },
  {
    key: 'ejecutivo_contact_priority',
    label: 'Ejecutivo prioridad',
    description: 'Prioridad del contacto ejecutivo según cargo.',
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
    key: 'uso_propiedad_inferido',
    label: 'Uso propiedad inferido',
    description: 'Clasificación de uso de propiedades.',
    category: 'patrimonio',
  },
  {
    key: 'bbrr_destinos',
    label: 'Destinos BBRR',
    description: 'Destinos de bienes raíces asociados.',
    category: 'patrimonio',
  },
  {
    key: 'n_propiedades_detalle',
    label: 'N° propiedades detalle',
    description: 'Conteo detallado de propiedades cargadas.',
    category: 'patrimonio',
  },
  {
    key: 'n_propiedades_residenciales',
    label: 'N° propiedades residenciales',
    description: 'Cantidad de propiedades residenciales.',
    category: 'patrimonio',
  },
  {
    key: 'n_propiedades_comerciales',
    label: 'N° propiedades comerciales',
    description: 'Cantidad de propiedades comerciales u operacionales.',
    category: 'patrimonio',
  },
  {
    key: 'n_propiedades_rurales',
    label: 'N° propiedades rurales',
    description: 'Cantidad de propiedades rurales productivas.',
    category: 'patrimonio',
  },
  {
    key: 'n_propiedades_indeterminadas',
    label: 'N° propiedades especiales',
    description: 'Cantidad de propiedades indeterminadas o especiales.',
    category: 'patrimonio',
  },
  {
    key: 'avaluo_residencial',
    label: 'Avalúo residencial',
    description: 'Suma de avalúos residenciales.',
    category: 'patrimonio',
  },
  {
    key: 'avaluo_comercial',
    label: 'Avalúo comercial',
    description: 'Suma de avalúos comerciales u operacionales.',
    category: 'patrimonio',
  },
  {
    key: 'avaluo_rural',
    label: 'Avalúo rural',
    description: 'Suma de avalúos rurales productivos.',
    category: 'patrimonio',
  },
  {
    key: 'avaluo_indeterminado',
    label: 'Avalúo especial',
    description: 'Suma de avalúos indeterminados o especiales.',
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
    key: 'equifax_lead_score',
    label: 'Equifax lead score',
    description: 'Score comercial Equifax calculado.',
    category: 'scoring',
  },
  {
    key: 'equifax_lead_temperature',
    label: 'Equifax color',
    description: 'Color de priorización Equifax.',
    category: 'scoring',
  },
  {
    key: 'equifax_contact_probability',
    label: 'Equifax prob. contacto',
    description: 'Probabilidad de contacto Equifax.',
    category: 'scoring',
  },
  {
    key: 'equifax_interest_probability',
    label: 'Equifax prob. interés',
    description: 'Probabilidad de interés Equifax.',
    category: 'scoring',
  },
  {
    key: 'equifax_purchase_probability',
    label: 'Equifax prob. compra',
    description: 'Probabilidad de compra Equifax.',
    category: 'scoring',
  },
  {
    key: 'equifax_fit_score',
    label: 'Equifax fit score',
    description: 'Puntaje de ajuste Equifax.',
    category: 'scoring',
  },
  {
    key: 'equifax_recommended_channel',
    label: 'Equifax canal recomendado',
    description: 'Canal recomendado por el scoring Equifax.',
    category: 'scoring',
  },
  {
    key: 'equifax_recommended_hour',
    label: 'Equifax hora recomendada',
    description: 'Hora recomendada para contactar.',
    category: 'scoring',
  },
  {
    key: 'equifax_scored_at',
    label: 'Equifax fecha score',
    description: 'Fecha de cálculo del score Equifax.',
    category: 'scoring',
  },
  {
    key: 'equifax_reason_tags',
    label: 'Equifax razones',
    description: 'Razones principales del score Equifax.',
    category: 'scoring',
  },
  {
    key: 'ventas_anio_ultimo',
    label: 'Ventas último año',
    description: 'Último año con datos de ventas.',
    category: 'actividad',
  },
  {
    key: 'ventas_resultado_tendencia',
    label: 'Tendencia ventas',
    description: 'Resultado de tendencia de ventas.',
    category: 'actividad',
  },
  {
    key: 'ventas_ultimo_tramo',
    label: 'Último tramo ventas',
    description: 'Último tramo de ventas disponible.',
    category: 'actividad',
  },
  {
    key: 'ventas_tramo_promedio',
    label: 'Tramo ventas promedio',
    description: 'Promedio de tramo de ventas 2020-2024.',
    category: 'actividad',
  },
  {
    key: 'ventas_cambio_promedio_anual',
    label: 'Cambio promedio ventas',
    description: 'Cambio promedio anual del tramo de ventas.',
    category: 'actividad',
  },
  {
    key: 'ventas_pendiente_tendencia',
    label: 'Pendiente tendencia ventas',
    description: 'Pendiente calculada para tendencia de ventas.',
    category: 'actividad',
  },
  {
    key: 'ventas_movimientos_alza',
    label: 'Movimientos alza ventas',
    description: 'Cantidad de movimientos de alza.',
    category: 'actividad',
  },
  {
    key: 'ventas_movimientos_baja',
    label: 'Movimientos baja ventas',
    description: 'Cantidad de movimientos de baja.',
    category: 'actividad',
  },
  {
    key: 'ventas_trabajadores_2024',
    label: 'Trabajadores 2024',
    description: 'Cantidad de trabajadores informada para 2024.',
    category: 'actividad',
  },
  {
    key: 'ventas_rubro_economico',
    label: 'Rubro económico ventas',
    description: 'Rubro económico de la fuente de ventas.',
    category: 'actividad',
  },
  {
    key: 'ventas_subrubro_economico',
    label: 'Subrubro económico ventas',
    description: 'Subrubro económico de la fuente de ventas.',
    category: 'actividad',
  },
  {
    key: 'ventas_actividad_economica',
    label: 'Actividad económica ventas',
    description: 'Actividad económica de la fuente de ventas.',
    category: 'actividad',
  },
  {
    key: 'ventas_region',
    label: 'Región ventas',
    description: 'Región informada en fuente de ventas.',
    category: 'ubicacion',
  },
  {
    key: 'ventas_comuna',
    label: 'Comuna ventas',
    description: 'Comuna informada en fuente de ventas.',
    category: 'ubicacion',
  },
  {
    key: 'wom_nombre',
    label: 'WOM nombre',
    description: 'Nombre informado por base WOM.',
    category: 'contacto',
  },
  {
    key: 'wom_direccion',
    label: 'WOM dirección',
    description: 'Dirección informada por base WOM.',
    category: 'ubicacion',
  },
  {
    key: 'wom_comuna',
    label: 'WOM comuna',
    description: 'Comuna informada por base WOM.',
    category: 'ubicacion',
  },
  {
    key: 'wom_lineas',
    label: 'WOM líneas',
    description: 'Cantidad de líneas informadas por WOM.',
    category: 'contacto',
  },
  {
    key: 'wom_valor',
    label: 'WOM valor',
    description: 'Valor informado por WOM.',
    category: 'contacto',
  },
  {
    key: 'wom_ciclo',
    label: 'WOM ciclo',
    description: 'Ciclo disponible en base WOM.',
    category: 'contacto',
  },
  {
    key: 'blacklist_phone_count',
    label: 'Blacklist teléfonos',
    description: 'Eventos de teléfonos marcados como problemáticos.',
    category: 'riesgo',
  },
  {
    key: 'blacklist_email_count',
    label: 'Blacklist emails',
    description: 'Eventos de emails marcados como problemáticos.',
    category: 'riesgo',
  },
  {
    key: 'blacklist_last_seen_at',
    label: 'Última blacklist',
    description: 'Última fecha observada en blacklist.',
    category: 'riesgo',
  },
  {
    key: 'blacklist_reasons',
    label: 'Razones blacklist',
    description: 'Razones consolidadas de blacklist.',
    category: 'riesgo',
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
