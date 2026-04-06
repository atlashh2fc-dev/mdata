export const SOURCE_TABLES = [
  {
    slug: 'master_personas',
    mysqlTable: 'master_personas',
    targetTable: 'master_personas',
    targetColumns: ['rutid'],
    aliases: {
      rutid: ['rutid', 'RUTID', 'rut', 'RUT'],
    },
  },
  {
    slug: 'pernat_resumen',
    mysqlTable: 'pernat_resumen',
    targetTable: 'pernat_resumen',
    targetColumns: ['rutid', 'nombres', 'paterno', 'materno', 'email', 'fono_cel', 'comuna_part', 'region_part'],
    aliases: {
      rutid: ['rutid', 'RUTID', 'rut', 'RUT'],
      nombres: ['nombres', 'nombre', 'NOMBRES', 'NOMBRE'],
      paterno: ['paterno', 'apellido_paterno', 'PATERNO', 'APELLIDO_PATERNO'],
      materno: ['materno', 'apellido_materno', 'MATERNO', 'APELLIDO_MATERNO'],
      email: ['email', 'correo', 'EMAIL', 'CORREO'],
      fono_cel: ['fono_cel', 'fono', 'telefono', 'celular', 'FONO_CEL', 'TELEFONO', 'CELULAR'],
      comuna_part: ['comuna_part', 'comuna', 'COMUNA_PART', 'COMUNA'],
      region_part: ['region_part', 'region', 'REGION_PART', 'REGION'],
    },
  },
  {
    slug: 'autos_resumen',
    mysqlTable: 'autos_resumen',
    targetTable: 'autos_resumen',
    targetColumns: ['rutid', 'n_autos'],
    aliases: {
      rutid: ['rutid', 'RUTID', 'rut', 'RUT'],
      n_autos: ['n_autos', 'autos', 'cantidad_autos', 'N_AUTOS', 'AUTOS'],
    },
  },
  {
    slug: 'empresa_resumen',
    mysqlTable: 'empresa_resumen',
    targetTable: 'empresa_resumen',
    targetColumns: ['rutid', 'razon_social_empresa'],
    aliases: {
      rutid: ['rutid', 'RUTID', 'rut', 'RUT'],
      razon_social_empresa: ['razon_social_empresa', 'razon_social', 'empresa', 'RAZON_SOCIAL_EMPRESA', 'RAZON_SOCIAL', 'EMPRESA'],
    },
  },
  {
    slug: 'domicilio_resumen',
    mysqlTable: 'domicilio_resumen',
    targetTable: 'domicilio_resumen',
    targetColumns: ['rutid', 'comuna', 'region'],
    aliases: {
      rutid: ['rutid', 'RUTID', 'rut', 'RUT'],
      comuna: ['comuna', 'COMUNA'],
      region: ['region', 'REGION'],
    },
  },
  {
    slug: 'acumulado_resumen',
    mysqlTable: 'acumulado_resumen',
    targetTable: 'acumulado_resumen',
    targetColumns: ['rutid', 'n_bienes_raices', 'totalavaluos'],
    aliases: {
      rutid: ['rutid', 'RUTID', 'rut', 'RUT'],
      n_bienes_raices: ['n_bienes_raices', 'cantidad_bienes_raices', 'N_BIENES_RAICES'],
      totalavaluos: ['totalavaluos', 'total_avaluos', 'TOTALAVALUOS', 'TOTAL_AVALUOS'],
    },
  },
]

export const INTEGER_COLUMNS = new Set(['n_autos', 'n_bienes_raices'])
export const NUMERIC_COLUMNS = new Set(['totalavaluos'])
export const FULL_REPLACE_ORDER = [
  'master_personas',
  'pernat_resumen',
  'autos_resumen',
  'empresa_resumen',
  'domicilio_resumen',
  'acumulado_resumen',
]
