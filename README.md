# Loom

A local macOS workspace for AI coding handoffs and usage.

Loom brings project folders, coding handoffs and usage into one place. Its first integration is designed to send a task from a local Claude Desktop Code chat to a saved Codex chat. Claude can then check for questions, pass along answers and collect the result. The complete handoff is still awaiting a live test in this preview.

- **Projects** — Pick a folder, save a goal and rules, and reopen the workspace later.
- **Local usage** — See measured Claude and Codex tokens by period, model and project, with allowance where available and estimated API value for supported Claude models.
- **Handoff views** — Explore chat maps, questions, results and patch review in the browser demo with sample data.

## What works today

| Area | Status | How it was checked |
| --- | --- | --- |
| macOS source build | Verified | The exported source built offline and produced an ad-hoc signed app bundle on Apple silicon. |
| Desktop projects | Verified in an earlier build | A manual run on 26 November 2026 opened Loom, created a project with the native folder picker, found it after relaunch, recognised duplicate folder selections and relinked a moved folder. The exported build's window has yet to be checked. |
| Browser demo | Checked with sample data | Fixture tests cover project setup, the chat map, questions and results, patch review and usage cards. |
| Local usage reader | Checked on real local files | Claude counts matched a separate parser for today and seven days. The reader produced Codex totals and a weekly allowance reading. Codex totals had no independent comparison. The 30-day Claude comparison and an interactive check of the native usage view are still open. |
| Desktop activity and usage views | Built and fixture-tested | Synthetic replies exercised the app and native handlers. The connected activity view and native usage view still need a real desktop run. |
| Claude Desktop → Codex handoff | Built and fixture-tested | Project connection, launch, question, answer and result handling were exercised with a simulated Codex server. Earlier probes exercised parts of the route with the real apps. The complete current flow still needs a run with signed-in accounts. |
| Write-enabled handoffs, Codex → Claude, OpenClaw and Antigravity | Not available | The Git worktree and patch code was tested in isolation. Write-enabled launches and the other integrations are outside this preview. |
| Installer and updates | Not available | Build Loom from source. There is no downloadable installer or update button yet. |

## Build from source

You need macOS, Git, the Xcode Command Line Tools, Node.js 24 and a Rust toolchain with Cargo. The build was checked on Apple silicon with Rust 1.96.1. Cargo needs access to the locked dependencies on the first build. With a populated Cargo cache you can add `--offline` to the build command.

```sh
git clone https://github.com/sinder2221/loom-ai.git
cd loom-ai
node desktop/prepare-dist.mjs
(cd desktop && cargo build --release --locked)
sh desktop/bundle-macos.sh
open desktop/target/release/bundle/macos/Loom.app
```

## First use

1. Choose **New project** and pick an existing local folder. Add a goal or rules if you want, then review and save. Saving opens the workspace without starting a chat.
2. Open **Dashboard** or **Harnesses** for **Local usage**. Pick a period, expand **By model**, or choose a saved project on the dashboard to see its subtotal. The reader uses records already on your Mac.
3. To explore the handoff screens with sample data, run `node app/serve.mjs` from the source root and open [the local demo](http://127.0.0.1:4173/).

For bridge development, `node bridge/mcp/install.ts` prints a proposed project configuration as a dry run. Live delegation requires a project connection and explicit runner setup.

## Privacy and permissions

- **Project and handoff records.** Loom saves project names, folder paths, goals and rules on your Mac. When the helper is in use, its local database can keep handoff briefs, chat references, questions, answers, results and audit events. Delegating would send the handoff brief and subsequent answers to Codex under its existing sign-in.
- **Usage files.** The reader examines local Claude project logs and Codex session logs for reported usage, model, time and project information. It can read an existing local Claude status-line snapshot for allowance. The usage cache keeps counts, quota readings and keyed fingerprints. It never stores raw transcripts, raw source paths, email addresses or raw message IDs.
- **Sign-in.** Loom relies on the provider apps for sign-in and does not collect provider passwords, API keys or login tokens. The helper creates its own local authorization files and can save a private copy of existing project MCP settings before editing them. The Codex account label is user-entered and unverified. Loom cannot detect a Codex account switch.
- **Project connection.** Saving a project records the selected folder in Loom. An explicit Claude connection adds a project-level MCP entry and skill. Claude chats in that connected folder share permission to queue read-only handoffs, read the project's replies and answer its pending questions.
- **Read-only delegation.** The Codex profile permits reads in the selected project and minimal platform paths. On macOS it can also read the system temporary folder (`/private/tmp`). The profile denies writes, network access and reads of Loom's private data directory. The macOS read boundaries were probed locally with synthetic files before the explicit private-directory rule was added. The current profile has yet to be exercised in a live model turn.

## Known limits

- This preview targets one user on one Mac. A clean first launch, confirmation when relinking to a different folder, folder aliases through symlinks or different letter case, use with a running helper, keyboard-only use and screen-reader use still need a manual desktop check.
- Visibility of new handoffs in the Codex Desktop chat list, closed-app delivery, forwarding direct Codex input and replacing a running Codex chat still need live verification.
- Usage depends on the local records available. Partial totals appear as lower bounds and missing figures show as **Unknown**. A stale allowance shows its last reported value. Codex cost estimates are unavailable. API value estimates describe token pricing, while subscription costs are outside those estimates.

## License

[AGPL-3.0-or-later](LICENSE) · Copyright loom-ai authors
