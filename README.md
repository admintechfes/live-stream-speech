# Event Captions

Live speech translation captions for **4 physically separated halls**, each with its own speaker
and its own audio feed. Speakers may use Tamil, Hindi or English and switch mid-sentence; every
screen shows English.

```
Hall N mics ─► AV mixer ─► USB audio interface ─► capture laptop (Chrome)
                                                        │ Azure Speech Translation
                                                        │ WebSocket
                                                        ▼
                                            relay (this server, one VM)
                                          routes strictly by hallId
                                                        ▼
                                            that hall's screens only
```

Everything dials **outbound** to the relay, so the four halls can be on four unrelated networks.

## Quick start

```bash
cp .env.example .env      # fill in AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, CONTROL_KEY
npm install
npm start
```

| Page | URL | Who opens it |
|---|---|---|
| Screen | `/screen.html?hall=hall-1` | Every TV/projector in that hall |
| Capture | `/capture.html?hall=hall-1&key=…` | The capture laptop in that hall, one per hall |
| Operator | `/operator.html?key=…` | The roaming lead |

Screens need no key. Capture and operator do, once `CONTROL_KEY` is set.

## Speech engine

`SPEECH_PROVIDER=azure` or `soniox`. The relay, the screens and the operator console are
engine-agnostic — they only ever see text — so switching is a config change, not a code change.

| | Azure | Soniox |
|---|---|---|
| Credential | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` | `SONIOX_API_KEY`, model via `SONIOX_MODEL` |
| In the browser | Speech SDK, `TranslationRecognizer` | `@soniox/speech-to-text-web`, loaded only when used |
| What the server hands out | 10-minute auth token, refreshed every 7 min | single-session temporary key, minted per start |

Both mint a **short-lived credential server-side**; neither real key ever reaches a browser.
`SOURCE_LANGS` and `PHRASE_LIST` are written once in Azure's shape and translated for Soniox
(`ta-IN,hi-IN,en-IN` → hints `ta,hi,en`; phrase list → context terms).

**Per-hall override:** `?provider=soniox` on a capture URL runs that one hall on the other engine.
This is how the A/B is run, and it is also the manual recovery path — if a hall's engine is
misbehaving, the minder reloads its capture page with the other provider. There is deliberately **no
automatic failover**: a code path that only fires under stress is the one you cannot rehearse.

The operator console shows a per-hall engine badge, so the lead can see which hall is on what
without asking.

If the selected provider's credentials are missing, or `SPEECH_PROVIDER` is a name it does not
recognise, **the server exits at boot** rather than failing when a minder first presses Start.

**HTTPS is mandatory** in production — browsers refuse microphone access on plain HTTP (localhost
excepted), so the capture page will not work without TLS.

## Day-1 spike

Run the same clip through both engines and compare:

```bash
ffmpeg -i raw-tamil.m4a -ar 16000 -ac 1 -c:a pcm_s16le sample-tamil.wav
node spike/azure-file-test.js  sample-tamil.wav
node spike/soniox-file-test.js sample-tamil.wav
```

Both print each translated line with its detected language and settle time, in the same format.
Judge the **text** by eye — that is what these are for. Azure's file input is processed faster than
realtime so its timings understate live lag; the Soniox spike paces audio at realtime and is closer
to honest. Neither replaces measuring from the mixer, in the hall.

The decision-quality test is the live A/B: one hall on `?provider=azure`, another on
`?provider=soniox`, same audio into both, watched side by side on the operator console. Tamil
code-switching mid-sentence is where the two will actually differ.

Verified working against a synthesized Tamil→Hindi→English clip: both non-English segments
translated correctly and continuous LID switched languages unprompted. Two things that showed up
and are worth watching with real speaker audio:

- **LID lags a language switch.** The English segment was still tagged `hi-IN` and came back
  slightly garbled (`You First Session Begins…`). Expect the first few words after a switch to be
  the weakest part of any caption.
- **`AZURE_SPEECH_REGION` is currently `eastus`.** If the venue is in India, move it to
  `centralindia` and re-run this spike — round-trip time is a direct addition to caption lag.

## Tests

```bash
npm test
```

Covers the failures that would actually embarrass you: **cross-talk between halls**, unknown/missing
hall refusal, the one-publisher-per-hall lock, replay on screen reload, per-hall blank, health
accuracy after a publisher drops, review-delay behaviour, control-key auth, provider mapping, and
the boot guards that refuse to start a misconfigured engine. Run it after any change and once on the
deployed VM before doors open.

## Screen URL parameters

| Param | Effect |
|---|---|
| `hall` | **Required.** No hall, or an unknown one, shows a large NOT CONFIGURED card rather than guessing |
| `size` | Caption font size in px (default 52). Tune from the back row, not the laptop. On phones this is automatically capped to the viewport, so one URL serves both a hall wall and a handset |
| `lines` | Visible lines (default 3) |
| `label=1` | Shows the hall name in the corner — use during setup to confirm each wall is on the right channel |
| `notice` | The standing "AI-generated translation · may contain errors" disclaimer, top-right. **On by default.** `notice=0` hides it; `notice=<text>` replaces the wording (e.g. a Tamil translation of it) |
| `logo=0` | Hides the Madhi logo (top-left). Shown by default |

## Operator console

One row per hall: capture-live dot, screen count, last-caption age, and the live caption text.

- **Blank** — per hall. The button that matters. Instantly hides captions and discards anything
  still inside the review delay.
- **BLANK ALL HALLS** / **spacebar** — panic control across every hall at once.
- **Freeze**, **Clear**, **A− / A+** — per hall.
- A hall showing `NO CAPTURE` or a growing last-caption age is a hall to radio about.

Set `CAPTION_DELAY_MS=1500` to hold finals back before they reach the walls. The operator sees
them immediately in amber, so there is a real window to hit Blank. Partials are suppressed while a
delay is configured, otherwise un-reviewed text would run ahead of it.

## Resilience built in

- Screens reconnect forever with backoff and **keep the last captions visible** while doing so, so
  a short blip is invisible to the audience rather than a black wall.
- Screens repaint recent lines instantly on reload from a per-hall replay buffer.
- Capture page restarts the recognizer on `Canceled` / `SessionStopped`, plus a **20s silence
  watchdog** for the case where Azure goes quiet without saying so.
- Azure auth tokens refresh every 7 minutes; the subscription key never reaches a browser.
- One publisher per hall — a forgotten capture tab cannot interleave captions into a live wall.
- Uncaught errors are logged, not fatal: one bad event in one hall must not take the other three
  off the air.

**Not covered:** there is no hardware fallback. If a hall loses internet, that hall loses captions
until it returns. Mitigate with a 4G/5G hotspot pre-paired to each capture laptop — the uplink, not
the last HDMI metre, is the real single point of failure.

## Deploy

Point the domain's **A record at the server first** — Caddy proves control of the domain over
ports 80/443, so it cannot get a certificate until DNS resolves. Open **80 and 443** (80 is needed
for the ACME challenge and the HTTPS redirect, not for traffic).

```bash
# Node 22 + pm2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs && sudo npm i -g pm2

# app
cd ~/event-captions
npm ci --omit=dev
cp .env.example .env && nano .env      # keys, HALLS, PORT=8080
openssl rand -hex 16                   # -> CONTROL_KEY

# raise the fd limit BEFORE pm2 starts: ~500 viewers is ~500 sockets in this
# process, and Ubuntu's default of 1024 is close enough to hurt.
sudo mkdir -p /etc/systemd/system/pm2-$USER.service.d
printf '[Service]\nLimitNOFILE=65535\n' | sudo tee /etc/systemd/system/pm2-$USER.service.d/limits.conf

pm2 start server.js --name captions
pm2 save && pm2 startup                # run the command it prints
sudo systemctl daemon-reload && pm2 restart captions
cat /proc/$(pgrep -f 'node server.js')/limits | grep 'open files'   # expect 65535
```

**Fork mode, one instance — never `pm2 -i`.** Hall state (subscribers, replay buffer, blank flag)
lives in this process's memory. A second worker gets its own empty copy, so viewers would be split
across two relays and half the room would sit on a black screen while the other half got captions.
Scaling out needs Redis pub/sub between processes; it is not a flag.

### Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile` in full:

```
captions.example.org {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -f          # watch the certificate being issued
```

That is the whole config. `reverse_proxy` passes WebSocket upgrades through untouched and, unlike
nginx, applies **no idle read timeout** — so a quiet hall between speakers does not get its socket
cut at 60 seconds. Certificates are obtained and renewed automatically; see below.

### Verifying it holds 500 viewers

```bash
# on the server
npm test

# from a DIFFERENT machine — localhost hides every cost that matters
ulimit -n 65535
node tests/load-screens.js wss://captions.example.org 500 hall-4 "$CONTROL_KEY"
```

Pick a hall that is **not live** — the test takes that hall's publisher slot. Watch `pm2 monit` and
the operator console while it runs: the screen count for that hall should read 500. Pass looks like
zero failed connects, under 1% missing deliveries, and fan-out p95 well under 500ms.

Fan-out is text only — roughly 25 KB/s total at 500 viewers — so CPU and bandwidth are not the
limit here. The things that actually break at this size are the file-descriptor ceiling above, and
reconnect storms when the relay restarts (viewers back off with jitter for exactly this reason).

## Pre-event checklist

- [ ] Both spikes run on real Tamil audio; live A/B done; `SPEECH_PROVIDER` set to the winner
- [ ] `PHRASE_LIST` seeded with speaker names, org names, event terms
- [ ] `CONTROL_KEY` set; capture/operator URLs distributed only to staff
- [ ] Azure concurrency limit confirmed for 4 simultaneous streams
- [ ] Cross-talk test: publish to each hall, confirm the other three stay untouched
- [ ] Per-hall kit: laptop, USB interface, XLR, hotspot pre-paired and failover tested
- [ ] Mixer line-out confirmed in every hall — never a room mic; peaks near −12 dBFS
- [ ] Legibility checked from the back row of each hall
- [ ] Hall minders drilled hands-on: Blank, Clear, Restart
- [ ] Per-hall run sheet printed and taped to each capture laptop
- [ ] 30+ minute soak per hall with no recognizer stall

## Run sheet template (one per hall, printed)

```
HALL: hall-2                      MINDER: ______________

Screens : https://captions.example.org/screen.html?hall=hall-2
Capture : https://captions.example.org/capture.html?hall=hall-2&key=…
Lead    : ______________  (radio channel ___)

Captions frozen or wrong        -> Blank, then reload the capture page and press Start
Captions stopped                -> check the capture page dot; press Stop then Start
Engine misbehaving all talk     -> reload capture with &provider=______ and press Start
Screen black                    -> reload the screen URL; check it says hall-2 top-left
Everything down                 -> switch the capture laptop to the backup hotspot
Something said that must not    -> Blank. Ask afterwards.
be on the wall
```
