'use strict'

const { mkdtemp, mkdir, writeFile, rm } = require('fs/promises')
const { execFile } = require('child_process')
const { promisify } = require('util')
const path = require('path')
const test = require('ava').default
const os = require('os')

const execFileAsync = promisify(execFile)
const SCRITCH_PATH = path.resolve(__dirname, '..')
const EXECUTABLE_MODE = 0o755

const writeExecutable = (filePath, content) =>
  writeFile(filePath, content, { mode: EXECUTABLE_MODE })

const createCli = async scripts => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scritch with spaces '))
  const scriptsDir = path.join(root, 'scripts')
  await mkdir(scriptsDir)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-cli', bin: { 'fixture-cli': 'cli.js' } })
  )
  await writeExecutable(
    path.join(root, 'cli.js'),
    `#!/usr/bin/env node\nrequire(${JSON.stringify(SCRITCH_PATH)})(__dirname)\n`
  )
  await Promise.all(
    Object.entries(scripts).map(([name, content]) =>
      writeExecutable(path.join(scriptsDir, name), content)
    )
  )
  return root
}

const run = (root, args) =>
  execFileAsync(process.execPath, [path.join(root, 'cli.js'), ...args], {
    env: { ...process.env, FORCE_COLOR: '0' }
  })

test('runs an extensionless bash script through its shebang', async t => {
  const root = await createCli({
    shell: '#!/usr/bin/env bash\nset -euo pipefail\necho "bash:$*"\n'
  })
  t.teardown(() => rm(root, { recursive: true, force: true }))
  const { stdout } = await run(root, ['shell', 'pod-name'])
  t.is(stdout.trim(), 'bash:pod-name')
})

test('runs a node script through its shebang', async t => {
  const root = await createCli({
    'hello.js':
      '#!/usr/bin/env node\nconsole.log("node:" + process.argv.slice(2).join(","))\n'
  })
  t.teardown(() => rm(root, { recursive: true, force: true }))
  const { stdout } = await run(root, ['hello', 'a b', 'c'])
  t.is(stdout.trim(), 'node:a b,c')
})

test('passes arguments verbatim without shell interpretation', async t => {
  const root = await createCli({
    'args.sh': '#!/bin/sh\nfor arg in "$@"; do echo "[$arg]"; done\n'
  })
  t.teardown(() => rm(root, { recursive: true, force: true }))
  const { stdout } = await run(root, ['args', 'a b', '$HOME', 'x;y'])
  t.is(stdout.trim(), '[a b]\n[$HOME]\n[x;y]')
})

test('does not emit node deprecation warnings', async t => {
  const root = await createCli({ 'ok.sh': '#!/bin/sh\necho ok\n' })
  t.teardown(() => rm(root, { recursive: true, force: true }))
  const { stdout, stderr } = await run(root, ['ok', 'arg'])
  t.is(stdout.trim(), 'ok')
  t.is(stderr, '')
})

test('propagates the script exit code', async t => {
  const root = await createCli({ 'fail.sh': '#!/bin/sh\nexit 3\n' })
  t.teardown(() => rm(root, { recursive: true, force: true }))
  const error = await t.throwsAsync(run(root, ['fail', 'arg']))
  t.is(error.code, 3)
})

test('injects scritch environment variables', async t => {
  const root = await createCli({
    'env.sh': '#!/bin/sh\necho "$SCRITCH_BIN_NAME $SCRITCH_SCRIPT_NAME"\n'
  })
  t.teardown(() => rm(root, { recursive: true, force: true }))
  const { stdout } = await run(root, ['env', 'arg'])
  t.is(stdout.trim(), 'fixture-cli env')
})
