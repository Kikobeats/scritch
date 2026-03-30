#!/usr/bin/env node

const { setTimeout } = require('node:timers/promises')

async function main () {
  const start = Date.now()

  console.log('Linting files...')

  for (let i = 0; i < 10; i++) {
    await setTimeout(100)
    console.log(`- File ${i} linted.`)
  }

  const end = Date.now()
  const total = end - start
  const rounded = Math.round(total * 1000) / 1000

  console.log(`10 files linted in ${rounded / 1000}s.`)
}

main().catch(error => console.error(error) || process.exit(1))
