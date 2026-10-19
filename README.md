# TypingLab

**A lightweight, local Chrome extension (Manifest V3) that simulates human-like typing in any webpage text box — built primarily for WhatsApp Web.**

TypingLab takes a piece of text (pasted or loaded from a `.txt` / `.pdf` file), humanizes it, and types it out character-by-character at a realistic pace with natural pauses, while keeping the session alive even when your screen is locked. Everything runs locally in your browser — no servers, no accounts, no data leaves your machine.

- Manifest Version: **3**
- Version: **1.1.0**
- Browser: **Chrome / Brave / Edge** (any Chromium browser)
- Permissions: `storage`, `alarms`, `offscreen`, `activeTab`, `scripting`, `power`

---

## What it does

| Feature | Description |
|---|---|
| **Humanized typing engine** | Types character-by-character with randomized delays per key, extra pauses after `.`, `,`, and spaces — mimics real typing rhythm instead of dumping text instantly. |
| **Anti-bot corpus synthesis** | Injects natural conversational filler phrases ("well", "hold on", "got it", …) roughly every 10 words so the output reads organically and defeats naive anti-bot heuristics. |
| **Three speed profiles** | Steady (≈45 WPM), Natural (≈65 WPM), Fast (≈90 WPM). |
| **Session timer** | Choose 5, 10, 15, or 20 minutes. A hard deadline alarm guarantees the session stops on time. |
| **Rolling or Append box** | "Rolling Box" clears the draft every 180 characters (keeps the input small and realistic); "Append" keeps adding to it. |
| **Lock-screen keep-awake** | Uses the `chrome.power` API to keep the system/worker awake so sessions continue while your screen is locked. |
| **Focus / visibility spoof** | Overrides `document.hasFocus()`, `visibilityState`, and `hidden` in the page while active, so the site never sees the tab as blurred or hidden. |
| **Unthrottled background timer** | Runs a Web Worker inside an Offscreen Document so typing keeps ticking at full rate even when Chrome throttles the service worker. |
| **Never sends messages** | Hard safety guard: CR/LF/Tab characters are replaced with spaces — the Enter key is never simulated, so no message is ever sent automatically. |
| **Persistent settings & text** | Your pasted text and all dropdown choices auto-save to `chrome.storage.local` and restore when you reopen the popup. |
| **Error & event logging** | A 50-entry ring buffer logs starts, pauses, milestones, and errors — viewable and clearable from the popup. |

---

## How it works (architecture)

```
popup.html / popup.js          →  UI: text input, settings, start/pause/stop, live stats, logs
        │  CMD_START / CMD_PAUSE / CMD_RESUME / CMD_STOP / GET_STATE
        ▼
service-worker.js              →  Session state machine, speed profiles, humanized corpus
        │                        builder, milestone tracking, alarms, keep-awake, logging
        ├── offscreen.html/js  →  Offscreen Document hosting an unthrottled Web Worker
        │                          timer that fires OFFSCREEN_TICK every 400 ms
        ├── focus-spoof.js     →  Injected into the page (MAIN world): spoofs focus &
        │                          visibility APIs while the session is active
        └── content.js         →  Injected into the page (ISOLATED world): finds the target
                                   input box and dispatches realistic keydown / beforeinput /
                                   input / keyup events per character
```

**Session flow:**

1. You paste text (or load a `.txt` / `.pdf`), pick duration + pace, and hit **Start Bot Session**.
2. The service worker humanizes the corpus, injects `focus-spoof.js` and `content.js` into the active tab, requests keep-awake, creates a hard-deadline alarm, and starts the offscreen timer.
3. Every ~400 ms tick, the worker computes how many characters should have been typed by now (respecting the randomized per-key delays) and sends them to the content script.
4. The content script locates the input box and inserts each character with full keyboard event simulation.
5. The session ends when the timer expires (`EXPIRED`), the text runs out (`COMPLETED`), you press Stop (`STOPPED`), or something goes wrong (`ERROR` — e.g. the chat box disappeared).

### Input box targeting order

1. WhatsApp Web compose box: `footer div[contenteditable="true"][role="textbox"]`, `div[contenteditable="true"][data-tab="10"]`, `#main footer div[contenteditable="true"]`
2. Currently focused editable element (`contenteditable`, `<textarea>`, `<input>`)
3. Any visible `contenteditable` div or `<textarea>` on the page

This means it also works on most other sites with a text field — put focus in the box before starting.

---

## Installation (load unpacked)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/Geet-Prince/typinglab-extension.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `typinglab-extension` folder
5. Pin the **TypingLab** icon to your toolbar for quick access

> After editing the code, press the reload (↻) button on the extension card in `chrome://extensions`.

---

## How to use

1. **Open your target page** — e.g. [web.whatsapp.com](https://web.whatsapp.com) — and open the chat where you want to type.
2. **Click the TypingLab icon** to open the popup.
3. **Provide your text** using either method:
   - Paste directly into the text area (auto-saved as you type), or
   - Click **Load .TXT / .PDF** and pick a file (PDFs are text-extracted from the first 512 KB; text is capped at 25,000 characters).
4. **Choose your settings:**
   - **Session Duration:** 5 / 10 / 15 / 20 minutes (20 is the max)
   - **Typing Speed:** Steady (45 WPM) · Natural (65 WPM) · Fast (90 WPM)
   - **Input Box Behavior:** Rolling Box (clears draft every 180 chars) · Append
5. Click **Start Bot Session**.
6. The badge shows **ON** (green) and the popup shows a live countdown, progress bar, characters processed, and the last 1K milestone.
7. Use **Pause / Resume** to hold the session, or **Stop** to end it early. You can close the popup — the session keeps running in the background.
8. Click **View Logs** at any time to see session events and errors; **Clear Logs** wipes them.

### Status meanings

| Status | Meaning |
|---|---|
| `IDLE` | No active session. |
| `RUNNING` | Typing is in progress (badge: `ON`). |
| `PAUSED` | Temporarily halted (badge: `II`). Keep-awake and timer are released. |
| `EXPIRED` | The session reached its time deadline. |
| `COMPLETED` | All text was typed before the deadline. |
| `STOPPED` | You ended the session manually. |
| `ERROR` | Something failed (see error message / logs). |

### Toolbar badge

- `ON` — session running
- `II` — session paused
- `ERR` — session errored
- *(empty)* — idle

---

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `activeTab` + `scripting` | Inject the typing and focus-spoof scripts into the tab you launch the session from. |
| `storage` | Persist your text, settings, session state, and logs locally. |
| `alarms` | Hard deadline that force-stops the session after the chosen duration. |
| `offscreen` | Host the unthrottled Web Worker timer so typing continues under service-worker throttling. |
| `power` | Keep the system awake so sessions survive a locked screen. |

**Privacy:** everything is local. No network requests, no telemetry, no accounts.

---

## File structure

```
typinglab-extension/
├── manifest.json       # MV3 manifest: permissions, background worker, popup
├── popup.html          # Popup UI (dark theme, timer, metrics, settings, logs)
├── popup.js            # Popup logic: settings persistence, file loading, controls
├── service-worker.js   # Core engine: state machine, humanizer, pacing, logging
├── content.js          # Page-side typewriter: input discovery + key event dispatch
├── focus-spoof.js      # Page-side focus/visibility API spoofing (MAIN world)
├── offscreen.html      # Offscreen document shell
├── offscreen.js        # Web Worker timer driving OFFSCREEN_TICK messages
└── README.md           # This file
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| *"Open WhatsApp Web or an active webpage before starting."* | You started on a `chrome://` page or a browser-internal URL. Open a normal webpage first. |
| *"Input box lost (NO_INPUT_BOX_FOUND)."* | The chat box disappeared mid-session (chat switched/closed). Reopen the chat and start again. |
| *"Cannot inject into this page"* | The page blocks script injection (e.g. Web Store, PDF viewer). Try a regular tab. |
| Nothing types, but status is RUNNING | Click into the message box once so the page has a valid target, then restart the session. |
| Typing stops after ~30s of idle | Service-worker throttling — make sure the offscreen timer is running (check logs for `Started ... KeepAwake: ON`). |
| Session doesn't survive screen lock | Some OS/browser combinations block `power.requestKeepAwake`; a warning is logged if unavailable. |

---

## Limitations

- Max **25,000 characters** per session (after humanization).
- Max session length: **20 minutes**.
- PDF text extraction is a lightweight heuristic (regex over the raw stream), not a full PDF parser — complex PDFs may extract partially.
- Enter is intentionally never simulated; messages are **never auto-sent**.
- The focus/visibility spoof applies only to the session's target tab and is removed on stop/pause.

---

## License

Use and modify freely for personal use.
