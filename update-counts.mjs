import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function run() {
  await supabase.from('data_sources').update({ record_count: 315591, last_job_status: 'completed' }).eq('source_table_name', 'empresa_resumen');
  await supabase.from('data_sources').update({ record_count: 3088300, last_job_status: 'completed' }).eq('source_table_name', 'domicilio_resumen');
  
  const { data } = await supabase.from('data_sources').select('name, record_count')
  console.log('Cantidades actualizadas:', data)
}
run()
