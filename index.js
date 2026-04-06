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

const getPromiseWithResolvers = () => {
  if (typeof Promise.withResolvers === 'function') {
    return Promise.withResolvers()
  }

  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

const scritch = async (
  dir,
  { scriptsPath = 'scripts', env = {}, help: helpTree = null } = {}
) => {
  const scriptsDir = path.resolve(dir, scriptsPath)
  const scripts = await getScripts(scriptsDir)

  const { packageJson: pkg, path: pkgPath } = readPkgUp.sync({
    cwd: parentDir,
    normalize: false
  })

  const pkgRootPath = path.dirname(pkgPath)
  const pkgNodeModulesBinPath = path.join(pkgRootPath, 'node_modules', '.bin')

  const cli = meow({ pkg, help: help({ pkg, scripts, helpTree }) })

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

  if (!script) {
    const prefix = cli.input.join('/')
    const groupScripts = scripts.filter(s => s.name.startsWith(prefix + '/'))

    if (groupScripts.length > 0) {
      const subScripts = groupScripts.map(s => ({
        ...s,
        name: s.name.slice(prefix.length + 1)
      }))
      const subHelpTree = resolveHelpSubTree(helpTree, cli.input)
      const groupUsage = prefix.replace(/\//g, ' ')

      console.log(`
  Usage
    ${gray(`$ ${binaryName(pkg)} ${groupUsage} <command> [...args]`)}

  Commands
${formatGroupedCommands(subScripts, subHelpTree)}
`)
      return
    }

    return cli.showHelp()
  }

  const scriptArgs = process.argv.slice(2 + matchLength)
  const wantsHelp =
    scriptArgs.length === 0 ||
    scriptArgs.includes('-h') ||
    scriptArgs.includes('--help')

  if (wantsHelp) {
    const segments = script.name.split('/')
    const helpEntry = resolveHelpSubTree(helpTree, segments)
    if (helpEntry && typeof helpEntry === 'object' && helpEntry.commands) {
      console.log(formatSubcommandHelp(binaryName(pkg), script.name, helpEntry))
      return
    }
  }

  const { promise, resolve, reject } = getPromiseWithResolvers()
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

  return promise
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
  isPlainObject(bin) ? Object.keys(bin)[0] : name || 'cli'

const gray = text => styleText('gray', text)

const dim = text => styleText('dim', text)

const formatSubcommandHelp = (bin, scriptName, helpObj) => {
  const { commands = {}, examples = [] } = helpObj
  const entries = Object.entries(commands)
  if (entries.length === 0) return ''
  const maxLen = Math.max(...entries.map(([name]) => name.length))
  const cmdLines = entries
    .map(([name, desc]) => `    ${gray(name.padEnd(maxLen))}  ${dim(desc)}`)
    .join('\n')
  const usage = scriptName.replace(/\//g, ' ')
  let output = `
  Usage
    ${gray(`$ ${bin} ${usage} <command> [...args]`)}

  Commands
${cmdLines}
`
  if (examples.length > 0) {
    const exLines = examples.map(ex => `    ${gray(`$ ${ex}`)}`).join('\n')
    output += `
  Examples
${exLines}
`
  }
  return output
}

const kebabToCamel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

const segmentKeys = seg => {
  const keys = new Set([seg])
  if (seg.includes('-')) keys.add(kebabToCamel(seg))
  return [...keys]
}

const resolveHelpSubTree = (tree, segments) => {
  if (!tree || typeof tree !== 'object') return null
  let node = tree
  for (const seg of segments) {
    let next
    for (const key of segmentKeys(seg)) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        next = node[key]
        break
      }
    }
    if (next === undefined || typeof next !== 'object' || next === null) {
      return null
    }
    node = next
  }
  return node
}

const lookupHelpDescription = (tree, segments) => {
  if (!tree || typeof tree !== 'object' || segments.length === 0) return ''

  let node = tree
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const isLast = i === segments.length - 1
    let next

    for (const key of segmentKeys(seg)) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        next = node[key]
        break
      }
    }

    if (next === undefined) return ''
    if (isLast) {
      if (typeof next === 'string') return next
      if (isPlainObject(next) && typeof next.description === 'string') {
        return next.description
      }
      return ''
    }
    if (typeof next !== 'object' || next === null) return ''
    node = next
  }

  return ''
}

const formatCommandLine = (depth, name, description, descStartCol) => {
  const indent = pad(depth)
  if (!description) return `${indent}${gray(name)}`
  const gap = descStartCol > 0 ? descStartCol - indent.length - name.length : 2
  return `${indent}${gray(name)}${' '.repeat(Math.max(2, gap))}${dim(
    description
  )}`
}

const globalDescStartColumn = rows => {
  let c = 0
  for (const r of rows) {
    if (!r.desc) continue
    const end = pad(r.depth).length + r.name.length + 2
    if (end > c) c = end
  }
  return c
}

const sortStrings = strings => [...strings].sort((a, b) => a.localeCompare(b))

const emptyNode = () => ({
  leaves: [],
  sub: Object.create(null)
})

const addPath = (node, parts) => {
  if (parts.length === 1) {
    node.leaves.push(parts[0])
    return
  }
  const [head, ...rest] = parts
  if (!node.sub[head]) node.sub[head] = emptyNode()
  addPath(node.sub[head], rest)
}

const pad = depth => '    ' + '  '.repeat(depth)

const buildTopItems = scripts => {
  const root = emptyNode()
  for (const { name } of scripts) {
    addPath(root, name.split('/'))
  }

  const topItems = []
  for (const leaf of sortStrings(root.leaves)) {
    topItems.push({ kind: 'leaf', name: leaf })
  }
  for (const key of sortStrings(Object.keys(root.sub))) {
    topItems.push({ kind: 'group', name: key, node: root.sub[key] })
  }
  topItems.sort((a, b) => a.name.localeCompare(b.name))

  return topItems
}

const collectHelpRows = (topItems, helpTree) => {
  const rows = []

  const walkNode = (node, depth, pathPrefix) => {
    for (const leaf of sortStrings(node.leaves)) {
      rows.push({
        depth,
        name: leaf,
        desc: lookupHelpDescription(helpTree, [...pathPrefix, leaf])
      })
    }
    for (const key of sortStrings(Object.keys(node.sub))) {
      rows.push({
        depth,
        name: key,
        desc: lookupHelpDescription(helpTree, [...pathPrefix, key])
      })
      walkNode(node.sub[key], depth + 1, [...pathPrefix, key])
    }
  }

  for (const item of topItems) {
    if (item.kind === 'leaf') {
      rows.push({
        depth: 0,
        name: item.name,
        desc: lookupHelpDescription(helpTree, [item.name])
      })
    } else {
      rows.push({
        depth: 0,
        name: item.name,
        desc: lookupHelpDescription(helpTree, [item.name])
      })
      walkNode(item.node, 1, [item.name])
    }
  }

  return rows
}

const formatGroupBody = (node, depth, pathPrefix, helpTree, descStartCol) => {
  const lines = []
  for (const leaf of sortStrings(node.leaves)) {
    const segments = [...pathPrefix, leaf]
    const desc = lookupHelpDescription(helpTree, segments)
    lines.push(formatCommandLine(depth, leaf, desc, descStartCol))
  }
  for (const key of sortStrings(Object.keys(node.sub))) {
    const segments = [...pathPrefix, key]
    const groupDesc = lookupHelpDescription(helpTree, segments)
    lines.push(formatCommandLine(depth, key, groupDesc, descStartCol))
    lines.push(
      ...formatGroupBody(
        node.sub[key],
        depth + 1,
        [...pathPrefix, key],
        helpTree,
        descStartCol
      )
    )
  }
  return lines
}

const formatGroupedCommands = (scripts, helpTree) => {
  const topItems = buildTopItems(scripts)
  const rows = collectHelpRows(topItems, helpTree)
  const descStartCol = globalDescStartColumn(rows)

  const lines = []
  for (let i = 0; i < topItems.length; i++) {
    const item = topItems[i]
    if (item.kind === 'leaf') {
      const desc = lookupHelpDescription(helpTree, [item.name])
      lines.push(formatCommandLine(0, item.name, desc, descStartCol))
    } else {
      const desc = lookupHelpDescription(helpTree, [item.name])
      lines.push(formatCommandLine(0, item.name, desc, descStartCol))
      lines.push(
        ...formatGroupBody(item.node, 1, [item.name], helpTree, descStartCol)
      )
    }
    if (i < topItems.length - 1) {
      const next = topItems[i + 1]
      if (item.kind === 'group' || next.kind === 'group') lines.push('')
    }
  }
  return lines.join('\n')
}

const help = ({ pkg, scripts, helpTree }) => `
  Usage
    ${gray(`$ ${binaryName(pkg)} <command> [...args]`)}
  
  Commands
${formatGroupedCommands(scripts, helpTree)}`

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
