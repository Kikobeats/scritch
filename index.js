'use strict'

const stripAnsiStream = require('strip-ansi-stream')
const supportsColor = require('supports-color')
const isExecutable = require('executable')
const { readdir } = require('fs/promises')
const readPkgUp = require('read-pkg-up')
const crossSpawn = require('cross-spawn')
const { gray } = require('picocolors')
const path = require('path')
const meow = require('meow')

// Prevent caching of this module so module.parent is always accurate
delete require.cache[__filename]
const parentDir = path.dirname(module.parent.filename)

const scritch = async (dir, { scriptsPath = 'scripts', env = {} } = {}) => {
  const scriptsDir = path.resolve(dir, scriptsPath)
  const scripts = await getScripts(scriptsDir)

  // Lookup package for CLI
  const { packageJson: pkg, path: pkgPath } = readPkgUp.sync({
    cwd: parentDir,
    normalize: false
  })

  const pkgRootPath = path.dirname(pkgPath)
  const pkgNodeModulesBinPath = path.join(pkgRootPath, 'node_modules', '.bin')

  const cli = meow({ pkg, help: help({ pkg, scripts }) })
  const script = scripts.find(script => script.name === cli.input[0])
  if (!script) return cli.showHelp()

  return new Promise(async (resolve, reject) => {
    const stdoutSupportsColor = supportsColor.stdout

    // Spawn matching script
    const subprocess = crossSpawn(script.filePath, process.argv.slice(3), {
      cwd: process.cwd(),
      shell: true,
      // only pipe if it does not support color as we lose ability to retain color otherwise
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

  // TODO: do in parallel?
  return dirents.reduce((acc, dirent) => {
    const name = dirent.name
      .replace(parentDir, '') // without parent dir
      .replace(/^\//, '') // without relative path slash
      .replace(path.extname(dirent.name), '') // without extension
      .replace(/\/index$/, '') // without index file

    const filePath = dirent.name

    if (!isExecutable.sync(filePath)) {
      throw new Error(`Expected path to be executable: "${filePath}"`)
    }

    acc.push({ name, filePath })
    return acc
  }, [])
}

const isPlainObject = val =>
  typeof val === 'object' && val !== null && !Array.isArray(val)

const binaryName = ({ name, bin }) =>
  isPlainObject(bin) ? Object.keys(bin)[0] : name ? name : 'cli'

const help = ({ pkg, scripts }) => `
  Usage
    ${gray(`$ ${binaryName(pkg)} <script> [...args]`)}
  
  Scripts
    ${gray(
      scripts
        .map((script, index) => `${index === 0 ? '' : '    '}- ${script.name}`)
        .join('\n')
    )}`

const readdirDeep = async dir => {
  const subdirs = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    subdirs.map(subdir => {
      subdir.name = path.resolve(dir, subdir.name)
      return subdir.isDirectory() ? readdirDeep(subdir.name) : subdir
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
