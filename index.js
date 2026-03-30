'use strict'

const stripAnsiStream = require('strip-ansi-stream')
const supportsColor = require('supports-color')
const isExecutable = require('executable')
const { readdir } = require('fs/promises')
const { styleText } = require('node:util')
const readPkgUp = require('read-pkg-up')
const $ = require('tinyspawn')
const path = require('path')
const meow = require('meow')

// Prevent caching of this module so module.parent is always accurate
delete require.cache[__filename]
const parentDir = path.dirname(module.parent.filename)

const scritch = async (dir, { scriptsPath = 'scripts', env = {} } = {}) => {
  const scriptsDir = path.resolve(dir, scriptsPath)
  const scripts = await getScripts(scriptsDir)

  const { packageJson: pkg, path: pkgPath } = readPkgUp.sync({
    cwd: parentDir,
    normalize: false
  })

  const pkgRootPath = path.dirname(pkgPath)
  const pkgNodeModulesBinPath = path.join(pkgRootPath, 'node_modules', '.bin')

  const cli = meow({ pkg, help: help({ pkg, scripts }) })

  let script = null
  let matchLength = 0

  for (let i = cli.input.length; i >= 1; i--) {
    const candidate = cli.input.slice(0, i).join('/')
    const found = scripts.find(s => s.name === candidate)
    if (found) {
      script = found
      matchLength = i
      break
    }
  }

  if (!script) return cli.showHelp()

  return new Promise(async (resolve, reject) => {
    const stdoutSupportsColor = supportsColor.stdout

    const subprocess = $(script.filePath, process.argv.slice(2 + matchLength), {
      cwd: process.cwd(),
      shell: true,
      stdio: stdoutSupportsColor ? 'inherit' : 'pipe',
      env: Object.assign(
        {},
        process.env,
        {
          PATH: `${pkgNodeModulesBinPath}:${scriptsDir}:${process.env.PATH}`,
          SCRITCH_SCRIPT_NAME: script.name,
          SCRITCH_SCRIPT_PATH: script.filePath,
          SCRITCH_SCRIPTS_DIR: scriptsDir
        },
        env
      )
    })

    if (!stdoutSupportsColor) {
      subprocess.stdout.pipe(stripAnsiStream()).pipe(process.stdout)
      subprocess.stderr.pipe(stripAnsiStream()).pipe(process.stderr)
    }

    subprocess.on('error', err => reject(err))

    subprocess.on('close', code => {
      if (code !== 0) process.exitCode = code
      resolve()
    })
  })
}

const getScripts = async scriptsDir => {
  const dirents = (await readdirDeep(scriptsDir)).filter(
    dirent => dirent.name !== path.resolve(scriptsDir, 'index.js')
  )

  return dirents.reduce((acc, dirent) => {
    if (!isExecutable.sync(dirent.name)) return acc

    const name = dirent.name
      .replace(scriptsDir, '')
      .replace(/^\//, '')
      .replace(path.extname(dirent.name), '')
      .replace(/\/index$/, '')

    acc.push({ name, filePath: dirent.name })
    return acc
  }, [])
}

const isPlainObject = val =>
  typeof val === 'object' && val !== null && !Array.isArray(val)

const binaryName = ({ name, bin }) =>
  isPlainObject(bin) ? Object.keys(bin)[0] : name ? name : 'cli'

const gray = text => styleText('gray', text)

const help = ({ pkg, scripts }) => `
  Usage
    ${gray(`$ ${binaryName(pkg)} <command> [...args]`)}
  
  Commands
    ${gray(
      scripts
        .map((script, index) => `${index === 0 ? '' : '    '}- ${script.name.replace(/\//g, ' ')}`)
        .join('\n')
    )}`

const readdirDeep = async dir => {
  const subdirs = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    subdirs.map(subdir => {
      subdir.name = path.resolve(dir, subdir.name)
      if (subdir.isDirectory()) {
        return path.basename(subdir.name).startsWith('_')
          ? []
          : readdirDeep(subdir.name)
      }
      return subdir
    })
  )

  return files
    .reduce((a, f) => a.concat(f), [])
    .filter(dirent => {
      return (
        !dirent.isDirectory() && !path.basename(dirent.name).startsWith('_')
      )
    })
}

module.exports = (...args) =>
  scritch(...args).catch(error => console.error(error) || process.exit(1))
