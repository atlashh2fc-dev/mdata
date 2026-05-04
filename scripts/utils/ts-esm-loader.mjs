import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function withKnownExtensions(filePath) {
  return [
    filePath,
    `${filePath}.ts`,
    `${filePath}.tsx`,
    `${filePath}.mts`,
    `${filePath}.cts`,
    `${filePath}.js`,
    `${filePath}.mjs`,
    `${filePath}.cjs`,
    path.join(filePath, 'index.ts'),
    path.join(filePath, 'index.tsx'),
    path.join(filePath, 'index.mts'),
    path.join(filePath, 'index.cts'),
    path.join(filePath, 'index.js'),
    path.join(filePath, 'index.mjs'),
    path.join(filePath, 'index.cjs'),
  ]
}

async function resolveFilePath(candidateBase) {
  for (const candidate of withKnownExtensions(candidateBase)) {
    try {
      await readFile(candidate)
      return candidate
    } catch {
      // try next
    }
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (
    typeof specifier === 'string' &&
    !specifier.startsWith('node:') &&
    !specifier.startsWith('file:') &&
    !specifier.startsWith('data:') &&
    !specifier.startsWith('@/') &&
    !specifier.startsWith('./') &&
    !specifier.startsWith('../') &&
    specifier.includes('/') &&
    !path.extname(specifier)
  ) {
    const parts = specifier.split('/')
    const packageName = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
    const packageSubpath = specifier.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/')
    if (packageSubpath) {
      const mapped = await resolveFilePath(path.join(PROJECT_ROOT, 'node_modules', packageName, packageSubpath))
      if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true }
    }
  }

  if (specifier?.startsWith('@/')) {
    const mapped = await resolveFilePath(path.join(PROJECT_ROOT, specifier.slice(2)))
    if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true }
  }

  if (context?.parentURL?.startsWith('file:') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const parentPath = fileURLToPath(context.parentURL)
    const mapped = await resolveFilePath(path.resolve(path.dirname(parentPath), specifier))
    if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true }
  }

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context)

  const filePath = fileURLToPath(url)
  const ext = path.extname(filePath).toLowerCase()
  if (!['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return nextLoad(url, context)

  const ts = await import('typescript')
  const sourceText = await readFile(filePath, 'utf8')

  const transpiled = ts.transpileModule(sourceText, {
    fileName: filePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      sourceMap: 'inline',
      inlineSources: true,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  })

  return {
    format: 'module',
    shortCircuit: true,
    source: transpiled.outputText,
  }
}
