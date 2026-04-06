// Auto-generated compatible types for Supabase client
// Refleja el schema real del sistema

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
      master_personas: {
        Row: { rutid: string; created_at: string; updated_at: string }
        Insert: { rutid: string; created_at?: string; updated_at?: string }
        Update: { rutid?: string; created_at?: string; updated_at?: string }
      }
      pernat_resumen: {
        Row: {
          id: string; rutid: string; nombres: string | null; paterno: string | null
          materno: string | null; email: string | null; fono_cel: string | null
          comuna_part: string | null; region_part: string | null
          created_at: string; updated_at: string
        }
        Insert: {
          id?: string; rutid: string; nombres?: string | null; paterno?: string | null
          materno?: string | null; email?: string | null; fono_cel?: string | null
          comuna_part?: string | null; region_part?: string | null
          created_at?: string; updated_at?: string
        }
        Update: {
          id?: string; rutid?: string; nombres?: string | null; paterno?: string | null
          materno?: string | null; email?: string | null; fono_cel?: string | null
          comuna_part?: string | null; region_part?: string | null
          created_at?: string; updated_at?: string
        }
      }
      autos_resumen: {
        Row: { id: string; rutid: string; n_autos: number; created_at: string; updated_at: string }
        Insert: { id?: string; rutid: string; n_autos?: number; created_at?: string; updated_at?: string }
        Update: { id?: string; rutid?: string; n_autos?: number; created_at?: string; updated_at?: string }
      }
      empresa_resumen: {
        Row: { id: string; rutid: string; razon_social_empresa: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; rutid: string; razon_social_empresa?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; rutid?: string; razon_social_empresa?: string | null; created_at?: string; updated_at?: string }
      }
      domicilio_resumen: {
        Row: { id: string; rutid: string; comuna: string | null; region: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; rutid: string; comuna?: string | null; region?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; rutid?: string; comuna?: string | null; region?: string | null; created_at?: string; updated_at?: string }
      }
      acumulado_resumen: {
        Row: { id: string; rutid: string; n_bienes_raices: number; totalavaluos: number; created_at: string; updated_at: string }
        Insert: { id?: string; rutid: string; n_bienes_raices?: number; totalavaluos?: number; created_at?: string; updated_at?: string }
        Update: { id?: string; rutid?: string; n_bienes_raices?: number; totalavaluos?: number; created_at?: string; updated_at?: string }
      }
      data_sources: {
        Row: {
          id: string; name: string; description: string | null; source_type: string
          is_active: boolean; config: Json; slug: string | null
          canonical_table: string | null; source_table_name: string | null
          primary_key_column: string | null; supports_incremental: boolean
          record_count: number; coverage_pct: number | null
          last_loaded_at: string | null; last_job_status: string | null
          last_error_message: string | null; created_by: string | null
          created_at: string; updated_at: string
        }
        Insert: {
          id?: string; name: string; description?: string | null; source_type?: string
          is_active?: boolean; config?: Json; slug?: string | null
          canonical_table?: string | null; source_table_name?: string | null
          primary_key_column?: string | null; supports_incremental?: boolean
          record_count?: number; coverage_pct?: number | null
          last_loaded_at?: string | null; last_job_status?: string | null
          last_error_message?: string | null; created_by?: string | null
          created_at?: string; updated_at?: string
        }
        Update: {
          id?: string; name?: string; description?: string | null; source_type?: string
          is_active?: boolean; config?: Json; slug?: string | null
          canonical_table?: string | null; source_table_name?: string | null
          primary_key_column?: string | null; supports_incremental?: boolean
          record_count?: number; coverage_pct?: number | null
          last_loaded_at?: string | null; last_job_status?: string | null
          last_error_message?: string | null; created_by?: string | null
          created_at?: string; updated_at?: string
        }
      }
      source_versions: {
        Row: {
          id: string; source_id: string; version_label: string; load_mode: string
          source_row_count: number; loaded_row_count: number; new_rows: number
          updated_rows: number; failed_rows: number; checksum: string | null
          source_snapshot_at: string | null; started_at: string; completed_at: string | null
          status: string; notes: string | null; metadata: Json; created_at: string
        }
        Insert: {
          id?: string; source_id: string; version_label: string; load_mode?: string
          source_row_count?: number; loaded_row_count?: number; new_rows?: number
          updated_rows?: number; failed_rows?: number; checksum?: string | null
          source_snapshot_at?: string | null; started_at?: string; completed_at?: string | null
          status?: string; notes?: string | null; metadata?: Json; created_at?: string
        }
        Update: {
          id?: string; source_id?: string; version_label?: string; load_mode?: string
          source_row_count?: number; loaded_row_count?: number; new_rows?: number
          updated_rows?: number; failed_rows?: number; checksum?: string | null
          source_snapshot_at?: string | null; started_at?: string; completed_at?: string | null
          status?: string; notes?: string | null; metadata?: Json
        }
      }
      ingestion_jobs: {
        Row: {
          id: string; source_id: string | null; file_name: string | null
          file_size: number | null; file_path: string | null; status: string
          total_rows: number; valid_rows: number; invalid_rows: number
          merged_rows: number; new_rows: number; error_message: string | null
          started_at: string | null; completed_at: string | null
          created_by: string | null; created_at: string; updated_at: string
        }
        Insert: {
          id?: string; source_id?: string | null; file_name?: string | null
          file_size?: number | null; file_path?: string | null; status?: string
          total_rows?: number; valid_rows?: number; invalid_rows?: number
          merged_rows?: number; new_rows?: number; error_message?: string | null
          started_at?: string | null; completed_at?: string | null
          created_by?: string | null; created_at?: string; updated_at?: string
        }
        Update: {
          id?: string; source_id?: string | null; file_name?: string | null
          file_size?: number | null; file_path?: string | null; status?: string
          total_rows?: number; valid_rows?: number; invalid_rows?: number
          merged_rows?: number; new_rows?: number; error_message?: string | null
          started_at?: string | null; completed_at?: string | null
          created_by?: string | null; created_at?: string; updated_at?: string
        }
      }
      ingestion_logs: {
        Row: {
          id: string; job_id: string; level: string; message: string
          row_number: number | null; raw_data: Json | null; created_at: string
        }
        Insert: {
          id?: string; job_id: string; level?: string; message: string
          row_number?: number | null; raw_data?: Json | null; created_at?: string
        }
        Update: { id?: string; job_id?: string; level?: string; message?: string }
      }
      source_column_mappings: {
        Row: {
          id: string; source_id: string; source_column: string; target_table: string
          target_column: string; transform_fn: string | null; is_rut_column: boolean
          is_required: boolean; created_at: string; updated_at: string
        }
        Insert: {
          id?: string; source_id: string; source_column: string; target_table: string
          target_column: string; transform_fn?: string | null; is_rut_column?: boolean
          is_required?: boolean; created_at?: string; updated_at?: string
        }
        Update: {
          id?: string; source_id?: string; source_column?: string; target_table?: string
          target_column?: string; transform_fn?: string | null; is_rut_column?: boolean
          is_required?: boolean
        }
      }
      segmentos: {
        Row: {
          id: string; name: string; description: string | null; filters: Json
          sql_query: string | null; row_count: number; last_computed: string | null
          is_active: boolean; created_by: string | null; created_at: string; updated_at: string
        }
        Insert: {
          id?: string; name: string; description?: string | null; filters?: Json
          sql_query?: string | null; row_count?: number; last_computed?: string | null
          is_active?: boolean; created_by?: string | null; created_at?: string; updated_at?: string
        }
        Update: {
          id?: string; name?: string; description?: string | null; filters?: Json
          sql_query?: string | null; row_count?: number; last_computed?: string | null
          is_active?: boolean
        }
      }
      staging_data: {
        Row: {
          id: string; job_id: string; row_number: number; raw_data: Json
          mapped_data: Json | null; rutid: string | null; is_valid_rut: boolean | null
          validation_errors: Json; status: string; created_at: string
        }
        Insert: {
          id?: string; job_id: string; row_number: number; raw_data: Json
          mapped_data?: Json | null; rutid?: string | null; is_valid_rut?: boolean | null
          validation_errors?: Json; status?: string; created_at?: string
        }
        Update: {
          id?: string; job_id?: string; row_number?: number; raw_data?: Json
          mapped_data?: Json | null; rutid?: string | null; is_valid_rut?: boolean | null
          validation_errors?: Json; status?: string
        }
      }
      audit_logs: {
        Row: {
          id: string; user_id: string | null; action: string; entity: string | null
          entity_id: string | null; old_data: Json | null; new_data: Json | null
          ip_address: string | null; user_agent: string | null; created_at: string
        }
        Insert: {
          id?: string; user_id?: string | null; action: string; entity?: string | null
          entity_id?: string | null; old_data?: Json | null; new_data?: Json | null
          ip_address?: string | null; user_agent?: string | null; created_at?: string
        }
        Update: { id?: string }
      }
      ai_analysis_logs: {
        Row: {
          id: string; analysis_type: string; input_data: Json | null; output_data: Json | null
          model: string; tokens_used: number | null; duration_ms: number | null
          created_by: string | null; created_at: string
        }
        Insert: {
          id?: string; analysis_type: string; input_data?: Json | null; output_data?: Json | null
          model?: string; tokens_used?: number | null; duration_ms?: number | null
          created_by?: string | null; created_at?: string
        }
        Update: { id?: string }
      }
    }
    Views: {
      master_personas_current: {
        Row: {
          rutid: string | null; nombres: string | null; paterno: string | null
          materno: string | null; nombre_completo: string | null; email: string | null
          fono_cel: string | null; comuna_part: string | null; region_part: string | null
          n_autos: number | null; tiene_autos: boolean | null
          razon_social_empresa: string | null; tiene_empresa: boolean | null
          domicilio_comuna: string | null; domicilio_region: string | null
          n_bienes_raices: number | null; totalavaluos: number | null
          tiene_bienes_raices: boolean | null; score_patrimonial: number | null
          cobertura_pct: number | null; region_canonica: string | null
          comuna_canonica: string | null; created_at: string | null; updated_at: string | null
        }
      }
      master_personas_view: {
        Row: {
          rutid: string | null; nombres: string | null; paterno: string | null
          materno: string | null; nombre_completo: string | null; email: string | null
          fono_cel: string | null; comuna_part: string | null; region_part: string | null
          n_autos: number | null; tiene_autos: boolean | null
          razon_social_empresa: string | null; tiene_empresa: boolean | null
          domicilio_comuna: string | null; domicilio_region: string | null
          n_bienes_raices: number | null; totalavaluos: number | null
          tiene_bienes_raices: boolean | null; score_patrimonial: number | null
          cobertura_pct: number | null; region_canonica: string | null
          comuna_canonica: string | null; created_at: string | null; updated_at: string | null
        }
      }
      dashboard_stats: {
        Row: {
          total_ruts: number | null; con_nombre: number | null; con_email: number | null
          con_fono: number | null; con_autos: number | null; total_autos: number | null
          con_empresa: number | null; con_domicilio: number | null; con_bienes_raices: number | null
          total_avaluos: number | null; jobs_completados: number | null
          jobs_fallidos: number | null; total_segmentos: number | null; last_refreshed: string | null
        }
      }
      dataset_overview: {
        Row: {
          id: string | null; name: string | null; slug: string | null; description: string | null
          source_type: string | null; is_active: boolean | null; config: Json | null
          created_by: string | null; created_at: string | null; updated_at: string | null
          canonical_table: string | null; source_table_name: string | null
          primary_key_column: string | null; supports_incremental: boolean | null
          record_count: number | null; coverage_pct: number | null
          last_loaded_at: string | null; last_job_status: string | null
          last_error_message: string | null; latest_version_id: string | null
          latest_version_label: string | null; latest_load_mode: string | null
          latest_source_row_count: number | null; latest_loaded_row_count: number | null
          latest_new_rows: number | null; latest_updated_rows: number | null
          latest_failed_rows: number | null; latest_version_status: string | null
          latest_version_completed_at: string | null
        }
      }
      stats_por_region: {
        Row: { region: string | null; total: number | null; con_email: number | null; con_fono: number | null }
      }
      stats_score_dist: {
        Row: { range: string | null; count: number | null }
      }
    }
    Functions: {
      validate_rut_cl: { Args: { rut: string }; Returns: boolean }
      format_rut_cl: { Args: { rut: string }; Returns: string }
      refresh_dashboard_stats: { Args: Record<never, never>; Returns: void }
      finalize_source_version: {
        Args: {
          p_source_slug: string
          p_version_label: string
          p_load_mode: string
          p_source_row_count: number
          p_loaded_row_count: number
          p_new_rows: number
          p_updated_rows: number
          p_failed_rows: number
          p_status: string
          p_notes?: string | null
          p_metadata?: Json
        }
        Returns: string
      }
    }
  }
}
