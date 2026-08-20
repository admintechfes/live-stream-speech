// Provider mapping and validation. Pure functions only — no network, no keys.
const {
  PROVIDERS,
  azureLocalesToSonioxHints,
  phraseListToContext,
  resolveProvider,
  validateProviderConfig,
} = require('../lib/providers')

let failures = 0
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + d}`)
  if (!c) failures++
}
const throws = (fn) => {
  try { fn(); return false } catch { return true }
}

// --- language hint mapping -------------------------------------------------
const hints = azureLocalesToSonioxHints(['ta-IN', 'hi-IN', 'en-IN'])
check('azure locales map to bare ISO codes', JSON.stringify(hints) === '["ta","hi","en"]', JSON.stringify(hints))
check(
  'duplicate locales collapse to one hint',
  JSON.stringify(azureLocalesToSonioxHints(['en-IN', 'en-US', 'ta-IN'])) === '["en","ta"]',
  JSON.stringify(azureLocalesToSonioxHints(['en-IN', 'en-US', 'ta-IN']))
)
check(
  'configured order is preserved (first hint weighs most)',
  JSON.stringify(azureLocalesToSonioxHints(['hi-IN', 'ta-IN'])) === '["hi","ta"]'
)
check('blank entries are dropped', JSON.stringify(azureLocalesToSonioxHints([' ', '', 'ta-IN'])) === '["ta"]')
check('empty input gives empty hints', JSON.stringify(azureLocalesToSonioxHints([])) === '[]')

// --- phrase list -> context ------------------------------------------------
const ctx = phraseListToContext(['Madhi Foundation', ' Kalam ', ''])
check('phrase list becomes context terms', JSON.stringify(ctx) === '{"terms":["Madhi Foundation","Kalam"]}', JSON.stringify(ctx))
check('empty phrase list yields no context object', phraseListToContext([]) === undefined)
check('whitespace-only phrase list yields no context', phraseListToContext(['  ', '']) === undefined)

// --- provider resolution ---------------------------------------------------
check('no override falls back to the configured default', resolveProvider('', 'azure') === 'azure')
check('override wins over the default', resolveProvider('soniox', 'azure') === 'soniox')
check('override is case-insensitive', resolveProvider('SONIOX', 'azure') === 'soniox')
check('unknown provider is refused, not silently defaulted', throws(() => resolveProvider('whisper', 'azure')))
check('every declared provider resolves', PROVIDERS.every((p) => resolveProvider(p, 'azure') === p))

// --- boot-time credential validation ---------------------------------------
check(
  'azure with both credentials passes',
  validateProviderConfig('azure', { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'centralindia' }).length === 0
)
check('azure missing region is caught', validateProviderConfig('azure', { AZURE_SPEECH_KEY: 'k' }).length === 1)
check('azure missing both is caught', validateProviderConfig('azure', {}).length === 2)
check('soniox with a key passes', validateProviderConfig('soniox', { SONIOX_API_KEY: 'k' }).length === 0)
check(
  'soniox missing its key is caught even when azure is configured',
  validateProviderConfig('soniox', { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'eastus' }).length === 1
)
check('an unknown provider name is itself a config error', validateProviderConfig('whisper', {}).length === 1)

console.log(failures === 0 ? '\nALL PROVIDER TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
