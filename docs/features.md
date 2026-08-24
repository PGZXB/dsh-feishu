# Feature List

Feature list for dsh-feishu. ✅ = shipped, 📋 = planned
(in roadmap order). Update this table when a feature lands.

| Feature | What it does | UX | Status |
|---|---|---|---|
| Live streaming cards | One chat = one dsh session; every turn renders a card that patches in place (tool calls, reasoning, markdown, tables stream live), finalizes to done/error/stopped | Streaming card with ⏹ stop / 🔁 retry / 📋 copy / ⋯ row details / ▾ collapse | ✅ |
| Control panel | `/panel` renders every command as a button — no command syntax to remember | ⚙️ panel card with paged, categorized buttons; pickers for model/permission/repo/session — the model picker switches the live session immediately (and shows the switched model as current) and records the default | ✅ |
| In-card approvals & questions | Permission escalations resolve as cards; the agent's questions (single/multi/free-text) answer in the chat | 🔐 approval card (Allow once / Reject); question card with options / free-text capture / cancel | ✅ |
| Session management | Sessions persist across restarts; list, resume, rename, archive ("delete" — removes the session from the active list, restorable from the archived list), export, fresh-start without data loss | `/sessions` picker card + session-detail card (Resume / Rename / Archive / Export); `/resume`, `/clear` | ✅ |
| Commands (20) | 15 surface commands + 5 web-equivalent wrappers; unknown slash commands pass through to dsh | Slash commands + panel buttons share one handler; working-state gate allows only safe commands mid-turn | ✅ |
| One-QR quick setup | `dsh-feishu-setup`: one Feishu QR scan creates/configures the app (bot, scopes, version, credentials) and writes the profile | Terminal-guided QR login with bot branding (name/avatar/description) prompts | ✅ |
| Groups & mentions | `/group` creates a group; mention modes (always/never/ambient); approvals/questions @ the requester | Group chat with bot, proactive @mentions on notices | ✅ |
| Reaction ack | Received message → GoGoGo emoji; turn end → DONE/ERROR | Two-stage reaction, configurable, can be disabled | ✅ |
| Scheduled reminders | The agent can schedule reminders via dsh-schedule; `/schedule` lists them | ⏰ Reminder card when a scheduled prompt fires | ✅ |
| Allowlists | `allowedChats` / `allowedUsers` gate who can talk to the bot | Env/config-driven, applied to messages and card actions | ✅ |
| Session-log export | `/export` sends the chat's session log as a downloadable file message | File message with markdown transcript | ✅ |
| Diagnostics | `/feishu-status` shows a diagnostic card (connection state, sessions, last inbound) | Read-only status card, usable mid-turn | ✅ |
| Inbound attachments | Images/files the user sends are saved to the workspace as plain files and the agent reads them by path; a bare file/image message registers as pending — a receipt card posts and the agent waits for your instruction | 📎 File received receipt (counts pending files); follow-up text makes the agent work on them | ✅ |
| Inbound wait-instruction | A bare file/image message does not start a turn by itself — the bytes land in the workspace, a NEW receipt card posts per file, and the agent waits for the next text message to drain the pending list into one turn | 📎 File received receipt (counts pending files); follow-up text drains them into one turn | ✅ |
| Inbound rich-text | Feishu rich-text (post) and video messages are no longer dropped: a post is serialized into ordered rich text + attachments (formatting and intra-bubble order preserved), a video is a plain file | Rich-text-with-text posts turn immediately; attachment-only posts / videos register as pending | ✅ |
| Outbound files/images | The agent can send a workspace file/image to the chat via a `send_file` tool it calls itself | Native Feishu image/file message + 📤 Sent receipt card | ✅ |
| Agent preset selection | Pick an agent preset (e.g. PTC mode) when choosing a working directory | Mode dropdown on the `/repo` / `/cd` picker card; preset binds to the new session | 📋 |
| Subagent manager | Tree view of subagents (parent→child, status, tokens, duration), open or cancel one | Panel tree view | 📋 |
| Settings panel | View models/providers, manage API keys, review default cwd/preset | Panel settings view | 📋 |
| Turn produced files | Files a turn produced surface at the end of the turn | Chips row at the card bottom; tap a chip to receive the file | ✅ |
| Message queue | Messages sent while a turn runs queue visibly; edit / delete / steer them | One dedicated "⏳" card per queued message (a lifecycle state per card: queued / editing / steering / steered / sent / removed); each card updated in place, terminal cards retained | ✅ |
| Model retry line | Model auto-retries surface instead of staying silent | Card status line "retrying (2/3) · 3s", expand for delay/reason | 📋 |
| Session stats line | Durable per-session usage: turns, steps, tool calls, tokens (input/output/cache) | One small line at the card bottom, rendered on the terminal card | ✅ |
| Context occupancy | Current session's context-window usage | Percent on the card bottom, rendered on the terminal card with the stats line | ✅ |
