import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = path.join(__dirname, '..', 'src', 'locales')
const BASE = 'en.json'

/** @param {unknown} obj */
/** @param {string} prefix */
function objectKeyPaths(obj, prefix = '') {
  const keys = []
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return keys
  for (const k of Object.keys(obj).sort()) {
    const p = prefix ? `${prefix}.${k}` : k
    keys.push(p)
    keys.push(...objectKeyPaths(/** @type {Record<string, unknown>} */ (obj)[k], p))
  }
  return keys
}

function main() {
  const basePath = path.join(LOCALES_DIR, BASE)
  if (!fs.existsSync(basePath)) {
    console.error(`check-locale-keys: missing base file ${basePath}`)
    process.exit(1)
  }

  const en = JSON.parse(fs.readFileSync(basePath, 'utf8'))
  const enKeys = new Set(objectKeyPaths(en))

  const files = fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()

  if (!files.includes(BASE)) {
    console.error(`check-locale-keys: ${BASE} not found in ${LOCALES_DIR}`)
    process.exit(1)
  }

  let failed = false
  for (const f of files) {
    if (f === BASE) continue
    const p = path.join(LOCALES_DIR, f)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const k = new Set(objectKeyPaths(j))
    const missing = [...enKeys].filter((x) => !k.has(x))
    const extra = [...k].filter((x) => !enKeys.has(x))
    if (missing.length || extra.length) {
      failed = true
      console.error(`\n${f}:`)
      if (missing.length) console.error('  missing keys (vs en.json):', missing.join(', '))
      if (extra.length) console.error('  extra keys (not in en.json):', extra.join(', '))
    }
  }

  if (failed) {
    console.error(
      '\ncheck-locale-keys: locale JSON files must share the same object key paths as src/locales/en.json',
    )
    process.exit(1)
  }
}

main()
