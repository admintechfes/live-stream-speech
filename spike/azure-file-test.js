#!/usr/bin/env node
'use strict'

/**
 * Day-1 spike: run a recorded clip through Azure Speech Translation exactly as
 * the live pipeline will, and print what you need to decide Azure vs Soniox.
 *
 *   node spike/azure-file-test.js sample-tamil.wav
 *
 * Input must be 16 kHz, 16-bit, mono WAV:
 *   ffmpeg -i raw.m4a -ar 16000 -ac 1 -c:a pcm_s16le sample-tamil.wav
 *
 * What to look at:
 *   - do the finals read as usable English?
 *   - are speaker names and domain terms right? (if not, seed PHRASE_LIST)
 *   - p50/p95 "settle time" — how long after speech ends a final arrives.
 *     The plan's exit criterion is captions usefully readable at <= 3s.
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const SDK = require('microsoft-cognitiveservices-speech-sdk')

const file = process.argv[2]
if (!file) {
  console.error('usage: node spike/azure-file-test.js <16k-mono.wav>')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error(`no such file: ${path.resolve(file)}`)
  process.exit(1)
}

const KEY = process.env.AZURE_SPEECH_KEY
const REGION = process.env.AZURE_SPEECH_REGION
if (!KEY || !REGION) {
  console.error('set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in .env first')
  process.exit(1)
}

const SOURCES = (process.env.SOURCE_LANGS || 'ta-IN,hi-IN,en-IN').split(',').map((s) => s.trim())
const TARGET = process.env.TARGET_LANG || 'en'
const PHRASES = (process.env.PHRASE_LIST || '').split(',').map((p) => p.trim()).filter(Boolean)

const config = SDK.SpeechTranslationConfig.fromSubscription(KEY, REGION)
config.addTargetLanguage(TARGET)
config.setProperty(SDK.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous')

const autoDetect = SDK.AutoDetectSourceLanguageConfig.fromLanguages(SOURCES)
const audio = SDK.AudioConfig.fromWavFileInput(fs.readFileSync(file))
const recognizer = SDK.TranslationRecognizer.FromConfig(config, autoDetect, audio)

if (PHRASES.length) {
  const grammar = SDK.PhraseListGrammar.fromRecognizer(recognizer)
  PHRASES.forEach((p) => grammar.addPhrase(p))
  console.log(`phrase list: ${PHRASES.length} entries\n`)
}

console.log(`file    : ${file}`)
console.log(`region  : ${REGION}`)
console.log(`sources : ${SOURCES.join(', ')} (continuous LID)  ->  ${TARGET}\n`)

const settleTimes = []
const langCounts = new Map()
let firstPartialAt = null
let lastPartialAt = null
const startedAt = Date.now()

const langOf = (e) => {
  try { return SDK.AutoDetectSourceLanguageResult.fromResult(e.result).language || '?' } catch { return '?' }
}

recognizer.recognizing = () => {
  const now = Date.now()
  if (firstPartialAt === null) firstPartialAt = now
  lastPartialAt = now
}

recognizer.recognized = (_s, e) => {
  if (e.result.reason !== SDK.ResultReason.TranslatedSpeech) return
  const text = e.result.translations.get(TARGET)
  if (!text || !text.trim()) return

  // Settle time: gap between the last interim update and the committed final.
  // This is the lag the audience actually perceives on a caption wall.
  const settle = lastPartialAt ? Date.now() - lastPartialAt : 0
  settleTimes.push(settle)
  lastPartialAt = null

  const lang = langOf(e)
  langCounts.set(lang, (langCounts.get(lang) || 0) + 1)

  const offset = (e.result.offset / 10_000_000).toFixed(1)
  console.log(`[${String(offset).padStart(6)}s] (${lang}, settle ${String(settle).padStart(4)}ms)  ${text}`)
}

recognizer.canceled = (_s, e) => {
  if (e.reason === SDK.CancellationReason.Error) console.error(`\ncanceled: ${e.errorDetails}`)
  finish()
}

recognizer.sessionStopped = () => finish()

let done = false
function finish() {
  if (done) return
  done = true
  recognizer.stopContinuousRecognitionAsync(() => {
    recognizer.close()
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
    console.log('-'.repeat(60))
    console.log('Judge the TEXT by eye against the audio — that is what this tool is for.')
    console.log('The timings are indicative only: file input is processed faster than')
    console.log('realtime, so settle times here understate live lag. Real end-to-end')
    console.log('latency can only be measured live, from the mixer, in the hall.')
    console.log('Exit criterion: usefully readable English at <= 3s, measured there.')
    process.exit(0)
  })
}

recognizer.startContinuousRecognitionAsync(
  () => console.log('recognizing…\n'),
  (err) => { console.error('start failed:', err); process.exit(1) }
)
