'use strict'

/**
 * Speech-provider plumbing. Everything that differs between Azure and Soniox
 * lives here, so `server.js` stays a relay and `capture.html` stays a UI.
 *
 * The pure functions are exported separately from the two network calls so the
 * mapping logic can be tested without credentials or a connection.
 */

const PROVIDERS = ['azure', 'soniox']

const SONIOX_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key'

// ---------------------------------------------------------------------------
// Pure mapping / validation
// ---------------------------------------------------------------------------

/**
 * SOURCE_LANGS is Azure-shaped (`ta-IN,hi-IN,en-IN`); Soniox wants bare ISO
 * codes. `en-IN` and `en-US` collapse to one hint, so dedupe while keeping
 * the configured order — the first hint carries the most weight.
 */
function azureLocalesToSonioxHints(locales) {
  const out = []
  for (const raw of locales || []) {
    const code = String(raw).trim().toLowerCase().split(/[-_]/)[0]
    if (code && !out.includes(code)) out.push(code)
  }
  return out
}

/** PHRASE_LIST (speaker names, org names, event terms) -> Soniox context. */
function phraseListToContext(phrases) {
  const terms = (phrases || []).map((p) => String(p).trim()).filter(Boolean)
  return terms.length ? { terms } : undefined
}

/**
 * Decide which provider a request runs on. `requested` comes from `?provider=`
 * on the capture URL so a single hall can be flipped mid-event without an .env
 * edit; anything unknown is refused rather than silently falling back.
 */
function resolveProvider(requested, defaultProvider) {
  const want = String(requested || '').trim().toLowerCase()
  if (!want) return defaultProvider
  if (!PROVIDERS.includes(want)) {
    const err = new Error(`Unknown provider "${want}". Expected one of: ${PROVIDERS.join(', ')}`)
    err.status = 400
    throw err
  }
  return want
}

/**
 * Boot-time credential check for the selected provider. Returns a list of
 * problems; an empty list means it is safe to start. Discovering a missing key
 * at boot beats discovering it when a hall minder first presses Start.
 */
function validateProviderConfig(provider, env) {
  const problems = []
  if (!PROVIDERS.includes(provider)) {
    return [`SPEECH_PROVIDER="${provider}" is not valid. Use one of: ${PROVIDERS.join(', ')}`]
  }
  if (provider === 'azure') {
    if (!env.AZURE_SPEECH_KEY) problems.push('AZURE_SPEECH_KEY is not set')
    if (!env.AZURE_SPEECH_REGION) problems.push('AZURE_SPEECH_REGION is not set')
  }
  if (provider === 'soniox') {
    if (!env.SONIOX_API_KEY) problems.push('SONIOX_API_KEY is not set')
  }
  return problems
}

// ---------------------------------------------------------------------------
// Credential issuing. Neither provider's real key ever reaches a browser.
// ---------------------------------------------------------------------------

// Azure tokens are valid ~10 min and rate-limited, so they are worth caching.
let azureTokenCache = { token: '', expiresAt: 0 }

async function issueAzureToken({ key, region, now = Date.now() }) {
  if (!key || !region) throw new Error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured')
  if (azureTokenCache.token && now < azureTokenCache.expiresAt) return azureTokenCache.token

  const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
  })
  if (!res.ok) throw new Error(`Azure token request failed: ${res.status} ${await res.text()}`)

  azureTokenCache = { token: await res.text(), expiresAt: now + 8 * 60 * 1000 }
  return azureTokenCache.token
}

/**
 * Soniox temporary keys are single-session and cheap, so they are minted per
 * request rather than cached. Deliberately no `max_session_duration_seconds` —
 * a hall's capture session must be allowed to run as long as the hall does.
 */
async function mintSonioxKey({ key, expiresInSeconds = 600, clientReferenceId }) {
  if (!key) throw new Error('SONIOX_API_KEY not configured')

  const res = await fetch(SONIOX_KEY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usage_type: 'transcribe_websocket',
      expires_in_seconds: expiresInSeconds,
      ...(clientReferenceId ? { client_reference_id: clientReferenceId.slice(0, 256) } : {}),
    }),
  })
  if (!res.ok) throw new Error(`Soniox temporary key request failed: ${res.status} ${await res.text()}`)

  const body = await res.json()
  return { apiKey: body.api_key, expiresAt: body.expires_at }
}

/** Test seam — the Azure cache is module state and must be resettable. */
function _resetAzureTokenCache() {
  azureTokenCache = { token: '', expiresAt: 0 }
}

module.exports = {
  PROVIDERS,
  azureLocalesToSonioxHints,
  phraseListToContext,
  resolveProvider,
  validateProviderConfig,
  issueAzureToken,
  mintSonioxKey,
  _resetAzureTokenCache,
}
