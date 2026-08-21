#!/usr/bin/env node
'use strict'

/**
 * Day-1 spike, Soniox side. Deliberately mirrors spike/azure-file-test.js so
 * the two outputs can be read side by side on the same clip.
 *
 *   node spike/azure-file-test.js  sample-tamil.wav
 *   node spike/soniox-file-test.js sample-tamil.wav
 *
 * Run it once per target language to prove both streams stay alive whatever is
 * being spoken — the requirement the whole multi-language design rests on:
 *
 *   node spike/soniox-file-test.js --target=en mixed-ta-hi-en.wav
 *   node spike/soniox-file-test.js --target=ta mixed-ta-hi-en.wav
 *
 * Input must be 16 kHz, 16-bit, mono WAV:
 *   ffmpeg -i raw.m4a -ar 16000 -ac 1 -c:a pcm_s16le sample-tamil.wav
 *
 * Unlike the Azure spike this one paces audio at wall-clock speed, because the
 * Soniox SDK offers it (`pace_ms`). That makes the settle times here closer to
 * honest than Azure's — but still not a substitute for measuring in the hall.
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { SonioxNodeClient } = require('@soniox/node')
const { azureLocalesToSonioxHints, phraseListToContext } = require('../lib/providers')

const argv = process.argv.slice(2)
const targetArg = (argv.find((a) => a.startsWith('--target=')) || '').split('=')[1]
const file = argv.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('usage: node spike/soniox-file-test.js [--target=ta] <16k-mono.wav>')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error(`no such file: ${path.resolve(file)}`)
  process.exit(1)
}

const KEY = process.env.SONIOX_API_KEY
if (!KEY) {
  console.error('set SONIOX_API_KEY in .env first')
  process.exit(1)
}

const MODEL = process.env.SONIOX_MODEL || 'stt-rt-v5'
const SOURCES = (process.env.SOURCE_LANGS || 'ta-IN,hi-IN,en-IN').split(',').map((s) => s.trim())
const HINTS = azureLocalesToSonioxHints(SOURCES)
// --target wins, then the first configured target language, then English.
const TARGET =
  targetArg ||
  String(process.env.TARGET_LANGS || process.env.TARGET_LANG || 'en').split(',')[0].trim()
const CONTEXT = phraseListToContext(
  (process.env.PHRASE_LIST || '').split(',').map((p) => p.trim()).filter(Boolean)
)

// 16 kHz mono s16le = 32000 bytes/sec. 100ms chunks, paced 100ms apart, is a
// fair imitation of a live mixer feed.
const SAMPLE_RATE = 16000
const CHUNK_MS = 100
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000
const WAV_HEADER_BYTES = 44

console.log(`file    : ${file}`)
console.log(`model   : ${MODEL}`)
console.log(`hints   : ${HINTS.join(', ')}  ->  ${TARGET} (one-way translation)`)
if (CONTEXT) console.log(`context : ${CONTEXT.terms.length} terms\n`)
else console.log('')

const client = new SonioxNodeClient({ api_key: KEY })
const session = client.realtime.stt({
  model: MODEL,
  audio_format: 'pcm_s16le',
  sample_rate: SAMPLE_RATE,
  num_channels: 1,
  language_hints: HINTS,
  enable_language_identification: true,
  enable_endpoint_detection: true,
  translation: { type: 'one_way', target_language: TARGET },
  ...(CONTEXT ? { context: CONTEXT } : {}),
})

const settleTimes = []
const langCounts = new Map()
let firstPartialAt = null
let lastPartialAt = null
let finalBuffer = ''
let lastLang = '?'
const startedAt = Date.now()

// Same line model the capture page builds: accumulate finals, flush on <end>.
function flush() {
  const text = finalBuffer.trim()
  finalBuffer = ''
  if (!text) return

  const settle = lastPartialAt ? Date.now() - lastPartialAt : 0
  settleTimes.push(settle)
  lastPartialAt = null
  langCounts.set(lastLang, (langCounts.get(lastLang) || 0) + 1)

  const at = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[${String(at).padStart(6)}s] (${lastLang}, settle ${String(settle).padStart(4)}ms)  ${text}`)
}

// This breakdown is the whole point of the flag. It answers the question the
// design depends on: when the speaker is ALREADY in the target language, does
// Soniox emit `original` tokens (so we can fall back to them and keep the
// stream alive), and does it avoid emitting a redundant translation as well?
const tokenStats = new Map() // "status/language" -> count
const base = (c) => String(c || '?').toLowerCase().split(/[-_]/)[0]
const TARGET_BASE = base(TARGET)

session.on('result', (result) => {
  const now = Date.now()
  if (firstPartialAt === null) firstPartialAt = now
  lastPartialAt = now

  for (const t of result.tokens || []) {
    if (t.text === '<end>' || t.text === '<fin>') continue
    const status = t.translation_status || 'none'
    const tl = base(t.language || t.source_language)
    const k = `${status} / ${tl}`
    tokenStats.set(k, (tokenStats.get(k) || 0) + 1)

    // The same keep-rule the capture page applies, so what prints here is
    // exactly what a screen would show.
    const keep = status === 'translation' || tl === TARGET_BASE
    if (!keep) continue
    if (t.source_language || t.language) lastLang = t.source_language || t.language
    if (t.is_final) finalBuffer += t.text
  }
})

session.on('endpoint', flush)
session.on('error', (err) => {
  console.error(`\nsession error: ${err.message}`)
  finish(1)
})

async function* chunks() {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(CHUNK_BYTES)
    let pos = WAV_HEADER_BYTES // skip the RIFF header; we declare the format above
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, pos)
      if (n <= 0) return
      pos += n
      yield new Uint8Array(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
}

let done = false
function finish(code = 0) {
  if (done) return
  done = true
  flush() // anything the last endpoint did not close out
  try { session.close() } catch {}

  const pct = (p) => {
    if (!settleTimes.length) return 'n/a'
    const s = [...settleTimes].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] + 'ms'
  }
  console.log('\n' + '-'.repeat(60))
  console.log(`finals            : ${settleTimes.length}`)
  console.log(`settle p50 / p95  : ${pct(50)} / ${pct(95)}`)
  console.log(`first partial     : ${firstPartialAt ? firstPartialAt - startedAt + 'ms after start' : 'never'}`)
  console.log(`languages detected: ${[...langCounts].map(([l, n]) => `${l}×${n}`).join(', ') || 'none'}`)
  console.log(`\ntokens by status / language  (target = ${TARGET_BASE}):`)
  for (const [k, n] of [...tokenStats].sort((a, b) => b[1] - a[1])) {
    const [status, tl] = k.split(' / ')
    const kept = status === 'translation' || tl === TARGET_BASE
    console.log(`  ${kept ? 'KEEP' : 'drop'}  ${k.padEnd(20)} ${n}`)
  }
  console.log('-'.repeat(60))
  console.log('READ THIS FIRST: every spoken segment must produce KEEP tokens. If a')
  console.log(`stretch spoken in ${TARGET_BASE} shows no "original / ${TARGET_BASE}" rows, the`)
  console.log('fallback is not firing and that language will go blank when the')
  console.log('speaker switches into it. If you see BOTH translation and original')
  console.log(`rows for ${TARGET_BASE}, text will double and originals must be dropped.`)
  console.log('')
  console.log('Judge the TEXT by eye against the audio, and against the Azure run')
  console.log('on the same clip — that comparison is the whole point of this tool.')
  console.log('Audio here is paced at realtime, so settle times are closer to live')
  console.log('than the Azure spike gives, but the hall is still the only real test.')
  console.log('Exit criterion: usefully readable English at <= 3s, measured there.')
  process.exit(code)
}

;(async () => {
  try {
    await session.connect()
    console.log('recognizing…\n')
    await session.sendStream(chunks(), { pace_ms: CHUNK_MS, finish: true })
    // Give the tail of the audio time to come back before printing stats.
    await new Promise((r) => setTimeout(r, 3000))
    finish()
  } catch (err) {
    console.error('failed:', err.message)
    process.exit(1)
  }
})()
