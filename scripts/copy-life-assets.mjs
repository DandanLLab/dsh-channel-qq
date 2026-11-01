// Build step: copy component assets (plain .js/.cjs/.html + data dirs, not TS)
// from src/{life,meme}/ into lib/{life,meme}/ so the runtime
// `import('./xxx.js')` in each wrapper resolves next to the compiled wrapper.
import { copyFileSync, mkdirSync, readdirSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// life: engine module + kb CLI
{
  const src = join(root, 'src', 'life')
  const dst = join(root, 'lib', 'life')
  mkdirSync(dst, { recursive: true })
  for (const f of readdirSync(src)) {
    if (f.endsWith('.js') || f.endsWith('.cjs')) copyFileSync(join(src, f), join(dst, f))
  }
  console.log('life assets copied →', dst)
}

// meme: vendored dsh-meme modules + panel + bundled pack
{
  const src = join(root, 'src', 'meme')
  const dst = join(root, 'lib', 'meme')
  mkdirSync(dst, { recursive: true })
  for (const f of readdirSync(src)) {
    if (f.endsWith('.js') || f.endsWith('.html') || f === 'LICENSE') copyFileSync(join(src, f), join(dst, f))
  }
  cpSync(join(src, 'bundled-pack'), join(dst, 'bundled-pack'), { recursive: true })
  console.log('meme assets copied →', dst)
}
