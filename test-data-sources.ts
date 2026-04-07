import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function run() {
  const { data } = await supabase.from('data_sources').select('*')
  console.log(data)
  
  // Actualicemos los counts
  await supabase.from('data_sources').update({ latest_loaded_row_count: 315591 }).eq('source_table_name', 'empresa_resumen');
  await supabase.from('data_sources').update({ latest_loaded_row_count: 3256002 }).eq('source_table_name', 'domicilio_resumen');
  
  console.log('Actualizado!')
}
run()
