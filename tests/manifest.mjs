#!/usr/bin/env node
/**
 * Packaging contract for this bundle.
 *
 * These invariants are cheap to state and expensive to violate. The one that matters
 * most was learned the hard way on 2026-10-13: the **id a client half registers with
 * must equal the package name**. The Host serves a client half as
 * `plugins/??<package>/client.js&rev=…`, keys the module graph by that package name,
 * and rejects a second registration of the same id. Renaming the package without
 * renaming the id therefore makes every cold boot die with
 * `duplicate factory registration for "<old id>"` → `web boot: 1 entry did not
 * activate`, while hot reloads keep working and hide it.
 *
 *   node tests/manifest.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name + '   → ' + error.message)
  }
}

check('包名是 kebab-case 的 dsh 插件名', () => {
  assert.match(manifest.name, /^dsh-plugin-[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

check('零 npm 依赖（只允许 node: 内置与 ctx 服务）', () => {
  assert.deepEqual(manifest.dependencies ?? {}, {})
  assert.deepEqual(manifest.peerDependencies ?? {}, {})
})

check('dsh.bundle.patch 声明存在且文件真的在', () => {
  const relative = manifest.dsh?.bundle?.patch
  assert.ok(relative, '缺少 dsh.bundle.patch')
  assert.ok(existsSync(join(root, relative)), `${relative} 不存在`)
})

check('bundle patch 插入的行以包名作为模块名', () => {
  const patch = readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8')
  const names = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((match) => match[1].trim())
  assert.ok(names.includes(manifest.name), `patch 里的 name 是 ${JSON.stringify(names)}，不含 ${manifest.name}`)
})

check('宿主半入口存在', () => {
  assert.ok(manifest.main, '缺少 main')
  assert.ok(existsSync(join(root, manifest.main)), `${manifest.main} 不存在`)
})

check('dsh.client.platform 是 web 且 ./client 导出指向真实文件', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  const relative = manifest.exports?.['./client']
  assert.ok(relative, '缺少 exports["./client"]')
  assert.ok(existsSync(join(root, relative)), `${relative} 不存在`)
})

check('客户端半注册的 id 必须等于包名（否则冷启动 duplicate registration）', () => {
  // Tolerate comments between `load({` and `id:` — that is where the warning lives.
  const match = /__ModuleLoader__\.load\(\{[\s\S]{0,600}?\bid:\s*["']([^"']+)["']/.exec(client)
  assert.ok(match, '没找到 __ModuleLoader__.load({ id })')
  assert.equal(match[1], manifest.name,
    `客户端注册 id=${match[1]}，包名=${manifest.name} —— 改包名时必须同步改这里`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
