# Screenshot checklist (README gallery)

The README currently stays text-only and minimal. Once these shots exist,
a compact "See it work" gallery section is added to the README (each shot
below maps to one caption). Each capture must be a **real shot of the real
bot in the real Feishu client** — never a test-rendered mockup (a hard rule
for the project's public material). Drop files into `docs/assets/` with the
exact names below, insert the markdown images, and verify every referenced
file exists before committing.

## Checklist

| # | File (`docs/assets/`) | What to capture | README slot |
|---|---|---|---|
| 1 | `streaming-mid.png` | A turn mid-stream: the card with the ⏹ Stop button, tool/think rows, live text | `See it work` → "A turn, in one card" |
| 2 | `streaming-done.png` | The **same** card after the turn: green header, full answer inside — the "finalizes in place, no second bubble" proof | same paragraph, right after #1 (mid→done side-by-side) |
| 3 | `approval.png` | An approval card (orange): tool name + reason + **✅ Allow once** / **❌ Reject** buttons | "Approvals, in the chat" |
| 4 | `approval-decided.png` | The same card after tapping Allow once: the static decided state (no buttons) | same paragraph |
| 5 | `question.png` | A question card (wathet): the question + option buttons (single-select) | "Questions, in the chat" |
| 6 | `question-answered.png` | The same card answered: static `Answer: …` confirmation | same paragraph |
| 7 | `panel.png` | The control panel card: status line + the grouped command-palette buttons (and pagination if visible) | "Control panel" |
| 8 | `sessions.png` | The `/sessions` picker: a dropdown of sessions (title · id, ★ current / ● live badges) and the session detail sub-view | "Sessions" |
| 9 | `export.png` | The exported session log as a file message in the chat | "Export" |
| 10 | `group.png` | A group chat: an @-mention answer (and ideally a failing turn's @-mention notice) | "Groups" |
| 11 | `demo.gif` | A short screen recording (≈15 s): message → card streams → green finalize → tap Allow once → question → answer. Desktop client, real bot | hero, below the surface model |

## Shooting tips

- Use the **real bot** (the `feishu-dev` profile) with a **real chat** —
  p2p for 1–10, a group for #10.
- Keep the frame on the card; trim the chat chrome to stay readable.
- Landscape, roughly 4:3 or 16:10; PNG for stills, GIF/WebP (~15 s) for the
  demo. Mobile client shots are welcome as an optional extra.
- Blur or avoid anything sensitive (real names, tokens, private paths) — the
  default working directory `/home/<user>/…` shows in cards; use a neutral
  cwd for the shots (e.g. `/cd /tmp/demo`).
- For the approval shot, trigger a sandbox-escalation tool call (ask the
  agent to run something that needs a permission escalation) and capture the
  card before and after tapping Allow once.
- For the question shot, ask the agent something with options, or trigger
  `ask_user_question` directly (e.g. "ask me a multiple-choice question").
