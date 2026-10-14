<div align="center">

![Codex and DSH: dispatch, develop, review, and refine](docs/assets/bridge-banner.svg)

# dsh-plugin-codex-bridge

**A development bridge between Codex and DeepSeek Harness**

Dispatch tasks from Codex, develop independently in DSH, and hand results back for review.<br>
Send review feedback to the original development session for fixes and verification.

[![CI](https://github.com/heswy/dsh-plugin-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/heswy/dsh-plugin-codex-bridge/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-64d8c2?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-a9a3ff?style=flat-square)](#compatibility-and-boundaries)

[简体中文](README.md) · **English**

[Quick start](#quick-start) · [Examples](#examples) · [Configuration](#configuration) · [Documentation](#documentation)

</div>

---

## From task dispatch to review and fixes

For workflows where Codex handles planning and review while DSH development sessions handle implementation. This project supplies the communication channels; the user determines task scope, developer selection, and authorization for Git operations and releases.

| Stage | How it works |
|---|---|
| **01 · Dispatch** | Codex uses `codex2dsh` to register a workspace, create a session, and send an authorized task. |
| **02 · Develop** | DSH implements and verifies in the task workspace. The plugin brings externally registered workspaces into the desktop sidebar. |
| **03 · Review** | After the developer commits, pushes, and opens a PR, `dsh2codex` validates Git state and notifies the specified Codex thread. |
| **04 · Refine** | Within existing authorization, Codex sends review feedback to the original DSH session for fixes and verification. |

## Three components, one workflow

DSH sessions follow a **single-writer** model. When the desktop holds a session's writer lock, writes from another host are rejected. This project relays requests through the owning host so external drivers can collaborate with active desktop sessions.

| Component | What it provides | Install in |
|---|---|---|
| **DSH plugin** | Periodic workspace reconciliation, manual refresh, a file inbox, and receipts. Messages queue by default without interrupting the current turn. | DSH plugin manager |
| **`codex2dsh`** | Workspace and development-session creation; task and review-feedback delivery to the original session. | Codex skill directory |
| **`dsh2codex`** | Validation of pushed Git state; delivery of verification summaries and PR information to the supervisor thread. A notification ledger handles deduplication. | DSH skill directory |

The plugin and both skills can be installed independently. The plugin uses only Node.js built-ins: **zero npm runtime dependencies**.

## Quick start

### 1. Prepare the environment

Use DSH `0.2.0-rc.2` and Node.js 20+. The full bidirectional workflow also requires Python 3.10+, Git, and a Codex CLI that supports `queue --thread --message`. See [compatibility and boundaries](#compatibility-and-boundaries).

### 2. Install the DSH plugin

Open **Settings → Plugins → Add plugin** and enter the repository URL:

```text
https://github.com/heswy/dsh-plugin-codex-bridge
```

An absolute path to a local checkout also works. Confirm that the plugin is enabled and keep the DSH desktop running.

### 3. Install both skills

Get the repository and copy each skill to its application's skill directory:

```sh
git clone https://github.com/heswy/dsh-plugin-codex-bridge.git
cd dsh-plugin-codex-bridge

mkdir -p ~/.dsh/skills ~/.codex/skills
cp -R skills/dsh2codex ~/.dsh/skills/
cp -R codex-skills/codex2dsh ~/.codex/skills/
```

These commands use the default directories; adjust paths for custom data or skill locations. For a one-way workflow, omit the skill for the other direction.

### 4. Check readiness

- `dsh-plugin-codex-bridge` is enabled in the plugin list.
- A workspace refresh button appears at the bottom of the sidebar; clicking it reconciles immediately.
- Run the following to inspect the host's session index and the handoff CLI capability:

```sh
node tools/send.mjs --list
python3 skills/dsh2codex/scripts/notify.py --probe
```

The session index updates roughly every 10 seconds by default. Check its timestamp, target session ID, and working directory; the file's existence alone does not establish current delivery readiness. `--probe` checks CLI capability without sending a notification.

## Examples

### Send review feedback to the original DSH session

Use `--list` to find the full session ID, then replace `<sessionId>` below:

```sh
node tools/send.mjs \
  --session '<sessionId>' \
  --text 'Address the PR review findings on the original task branch and add relevant verification.' \
  --mode queue \
  --from codex \
  --id review-followup-001
```

Default `queue` delivery waits for the current turn to finish; `steer` is rejected by default. **Both `ok: true` and `accepted: true` confirm session acceptance. Acceptance does not mean the task is complete.** A receipt with `queuedBehindRunningTurn: true` means the message is waiting behind the current turn.

Sender exit codes: `0` indicates a successful delivery call, `1` indicates rejection or failure, and `2` indicates invalid usage or a receipt timeout. Inspect `accepted` in the receipt to confirm acceptance. After a timeout, inspect the original request and receipt rather than blindly resending or changing the request ID.

### Hand development results back to Codex

Prepare a verification summary and an explicit supervisor thread UUID. Preview the notification first:

```sh
python3 skills/dsh2codex/scripts/notify.py \
  --thread '<supervisor-thread-uuid>' \
  --repo '/absolute/path/to/task-worktree' \
  --branch 'task-branch' \
  --pr-url 'https://github.com/owner/repo/pull/123' \
  --summary-file '/absolute/path/to/verification-summary.md' \
  --dry-run
```

After checking the preview, remove `--dry-run` to send. The script checks the current branch, a clean working tree, the match between the `origin` push repository and PR URL, and whether the full HEAD exists on the remote task branch. **The supervisor independently checks the PR's actual head and reviews the change.**

Notification states are `queued`, `already-queued`, `blocked`, and `unknown`. A deterministic event ID and local ledger prevent automatic duplicate sends; uncertain outcomes stop with the record preserved. This is conservative deduplication, not a guarantee of end-to-end exactly-once delivery under arbitrary failures.

## Configuration

Override settings in the **profile's own `cordis.patch.yml`**, which applies after the bundle configuration:

```yaml
- id: workspace-sync
  config:
    intervalMs: 15000
    inbox:
      allowSteer: false
```

Default intervals are 5 seconds for workspace reconciliation and 1 second for inbox polling. If `DSH_HOME` is unset, the data directory is `~/.dsh`.

<details>
<summary><strong>Full configuration reference</strong></summary>

| Field | Default | Description |
|---|---|---|
| `routePath` | `/api/workspace-sync` | Host API route; must start with `/api/`. The client button uses the default route. |
| `registryFile` | `<DSH_HOME>/storages/workspace.json` | Shared workspace registry file. |
| `stateFile` | `<DSH_HOME>/workspace-sync/state.json` | Persistent deletion memory. |
| `autoSync` | `true` | Periodic workspace reconciliation. |
| `intervalMs` | `5000` | Reconciliation interval, 1000–600000 ms. |
| `includeUngroupedSessions` | `false` | Infer workspaces from session directories; off by default to avoid restoring deleted workspaces. |
| `attachSessions` | `true` | Account sessions whose cwd falls inside a workspace, populated ones included (idempotent; the registry re-validates `header.cwd`). |
| `clientRefresh` | `true` | Whether a click reloads this view (the session catalog is pulled once per connection, so external sessions never arrive by push): `true` always, `'on-change'` only when the pass changed something, `false` off. |
| `excludeDshHome` | `true` | Exclude candidate workspaces inside the DSH data directory. |
| `maxAddsPerPass` | `20` | Maximum additions per pass, 1–200. |
| `verbose` | `false` | Log every reconciliation pass. |
| `inbox.enabled` | `true` | Enable the inbox. |
| `inbox.dir` | `<DSH_HOME>/inbox` | Directory for requests, receipts, and the session index. |
| `inbox.intervalMs` | `1000` | Inbox polling interval, 200–600000 ms. |
| `inbox.allowSteer` | `false` | Allow interruption of the current turn; requires explicit opt-in. |
| `inbox.maxTextBytes` | `200000` | Maximum UTF-8 message size, 1–10000000 bytes. |
| `inbox.indexIntervalMs` | `10000` | Session index refresh interval, 1000–600000 ms. |
| `inbox.deliveryTimeoutMs` | `30000` | Per-delivery timeout, 1000–600000 ms. |

</details>

<details>
<summary><strong>Host API and development mounting</strong></summary>

| Request | Purpose |
|---|---|
| `GET /api/workspace-sync` | Configuration, latest reconciliation result, and capability-check status. |
| `POST /api/workspace-sync?action=sync` | Reconcile immediately. |
| `GET /api/workspace-sync?action=doctor` | Run capability checks. |

For development, mount manually in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: workspace-sync
      name: '/absolute/path/to/dsh-plugin-codex-bridge/lib/index.js'
```

Choose either manual mounting or installation through the plugin manager to avoid loading the plugin twice.

</details>

## Compatibility and boundaries

| Component | Requirements and validation scope |
|---|---|
| DSH plugin | Targets DSH `0.2.0-rc.2`; Node.js 20+. Documented hands-on testing on macOS; plugin CI is configured for Linux and macOS. |
| `dsh2codex` | Python **3.9+**, Git, and a Codex CLI supporting `queue --thread --message`; check with `--probe`. |
| `codex2dsh` | Python 3.10+ and DSH CLI/host access. The task-creation script uses POSIX `fcntl`. |
| Platforms and hosting | Windows is unverified. Handoff repository and PR URL validation supports `github.com`. |

- **Synchronization:** Polling and manual refresh. Once the plugin is loaded, external workspace synchronization needs no desktop restart. Host code changes require a restart or reinstallation.
- **Workspace lifecycle:** Adds missing local registrations. Session-directory inference is off by default, and deletion memory is persisted. Explicit registrations in the shared file can still override deletion memory.
- **Shared writes:** Concurrent host writes to `workspace.json` may still overwrite one another. Periodic reconciliation does not provide cross-process transactions.
- **Session ownership:** Writes go through the owning host. On `session/writer-held` or an uncertain outcome, inspect ownership and receipts.
- **Compatibility checks:** The plugin depends on internal DSH service contracts. Runtime `doctor` checks report drift; the absence of a version gate does not imply compatibility with every DSH version.
- **Authorization:** The plugin does not automatically commit, push, create PRs, merge, or publish. Use the skills within the user's authorized task scope.

## Documentation

The deeper guides below are currently primarily in Chinese. This README provides the complete English overview and reference.

| Guide | Contents |
|---|---|
| [Codex integration](docs/FOR-CODEX.md) | Session discovery, message delivery, and integration entry points. |
| [Inbox protocol](docs/codex-handoff.md) | Request fields, result files, receipt semantics, and handling rules. |
| [Internals](docs/internals.md) | Workspace reconciliation, deletion memory, session locks, and documented observations. |
| [Changelog](CHANGELOG.md) | Version history, fixes, and known boundaries. |
| [`codex2dsh`](codex-skills/codex2dsh/README.md) | Task dispatch and review feedback from Codex. |
| [`dsh2codex`](skills/dsh2codex/README.md) | Handoff notifications and outcome handling from DSH. |

## Development and verification

Run the offline tests from the repository root. No live DSH or Codex service is required:

```sh
node tests/harness.mjs
node tests/inbox.mjs
node tests/relay-e2e.mjs
python3 skills/dsh2codex/tests/test_notify.py
python3 codex-skills/codex2dsh/scripts/test_new_task.py
```

Preview local workspace candidates without mutation: `node tests/dry-run.mjs`. See [ci.yml](.github/workflows/ci.yml) for the CI definition.

Contributions should preserve three principles: **explicit targets, controlled repeat operations, and auditable outcomes**. Skills in this repository are the source files; installed copies must be updated separately when appropriate. [Issues](https://github.com/heswy/dsh-plugin-codex-bridge/issues) and PRs are welcome.

---

<div align="center">

[MIT License](LICENSE) · **heswy**<br>
The plugin and both skills each include the same MIT license.

[简体中文](README.md) · [Back to top](#dsh-plugin-codex-bridge)

</div>
