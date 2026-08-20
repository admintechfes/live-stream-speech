#!/usr/bin/env node
'use strict'

/**
 * Fan-out load test. Answers one question: with N viewers watching a hall, does
 * a caption still reach all of them promptly?
 *
 *   node tests/load-screens.js wss://captions.example.org 500 hall-1 <CONTROL_KEY>
 *
 * It opens N screen sockets, then acts as that hall's publisher and sends
 * timestamped finals. Each client records when the line arrived, so the report
 * is the spread the back row of the hall would actually experience.
 *
 * Run it from a machine that is NOT the server — otherwise you are measuring
 * your own laptop's socket limit, and localhost hides every network cost that
 * matters. Warning: it takes the hall's publisher slot, so do not point it at a
 * hall that is live.
 */

const WebSocket = require('ws')

const [, , baseArg, countArg, hallArg, keyArg] = process.argv
if (!baseArg) {
  console.error('usage: node tests/load-screens.js <wss://host> [count=500] [hall=hall-1] [controlKey]')
  process.exit(1)
}

const BASE = baseArg.replace(/\/+$/, '').replace(/^http/, 'ws')
const COUNT = Number(countArg || 500)
const HALL = hallArg || 'hall-1'
const KEY = keyArg || ''

const RAMP_PER_SEC = 50 // connect in a ramp; a 500-socket burst tests nothing useful
const ROUNDS = 10
const ROUND_MS = 2000

const clients = []
let connected = 0
let failed = 0
const failReasons = new Map()
const latencies = [] // ms, one entry per (client, message)
let delivered = 0
let expected = 0

const pct = (arr, p) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function openScreen(i) {
  const ws = new WebSocket(`${BASE}/ws?role=screen&hall=${encodeURIComponent(HALL)}`)
  ws.on('open', () => { connected++ })
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m.type !== 'final') return
    // The publisher stamps send-time into the caption text itself, so no clock
    // sync between processes is needed — same process sends and receives.
    const sent = Number(String(m.text).split('|')[1])
    if (sent) { latencies.push(Date.now() - sent); delivered++ }
  })
  ws.on('error', (err) => {
    failed++
    const k = err.code || err.message
    failReasons.set(k, (failReasons.get(k) || 0) + 1)
  })
  clients.push(ws)
}

;(async () => {
  console.log(`target : ${BASE}`)
  console.log(`viewers: ${COUNT} on ${HALL}`)
  console.log(`ramp   : ${RAMP_PER_SEC}/sec\n`)

  for (let i = 0; i < COUNT; i++) {
    openScreen(i)
    if ((i + 1) % RAMP_PER_SEC === 0) {
      await sleep(1000)
      console.log(`  ${connected} connected, ${failed} failed`)
    }
  }
  await sleep(3000)
  console.log(`\nconnected: ${connected}/${COUNT}   failed: ${failed}`)
  if (failed) {
    for (const [k, n] of failReasons) console.log(`  ${k}: ${n}`)
  }
  if (!connected) process.exit(1)

  const pub = new WebSocket(`${BASE}/ws?role=publisher&hall=${encodeURIComponent(HALL)}&key=${encodeURIComponent(KEY)}`)
  pub.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.type === 'error') {
      console.error(`\npublisher refused: ${m.code} — ${m.message}`)
      console.error('Pass the CONTROL_KEY as the 4th argument, and pick a hall that is not live.')
      process.exit(1)
    }
  })
  await new Promise((r) => pub.on('open', r))

  console.log(`\nsending ${ROUNDS} captions, ${ROUND_MS}ms apart…`)
  for (let r = 0; r < ROUNDS; r++) {
    const live = clients.filter((c) => c.readyState === WebSocket.OPEN).length
    expected += live
    pub.send(JSON.stringify({ type: 'final', text: `load test line ${r}|${Date.now()}` }))
    await sleep(ROUND_MS)
  }
  await sleep(1500)

  const lossPct = expected ? (100 * (expected - delivered)) / expected : 100
  console.log('\n' + '-'.repeat(60))
  console.log(`sockets still open : ${clients.filter((c) => c.readyState === WebSocket.OPEN).length}/${COUNT}`)
  console.log(`deliveries         : ${delivered}/${expected}  (${lossPct.toFixed(2)}% missing)`)
  console.log(`fan-out p50        : ${pct(latencies, 50)}ms`)
  console.log(`fan-out p95        : ${pct(latencies, 95)}ms`)
  console.log(`fan-out max        : ${Math.max(...latencies, 0)}ms`)
  console.log('-'.repeat(60))
  console.log('What good looks like: 0 failed connects, <1% missing, p95 well under')
  console.log('500ms. A rising max with a flat p50 means the server is fine and one')
  console.log('client was starved — usually this script running out of local sockets.')
  console.log('Check `ulimit -n` here before blaming the server.')
  process.exit(lossPct > 1 || failed > 0 ? 1 : 0)
})()
