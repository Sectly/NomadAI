# AI VM Simulation — Claude Code Build Spec (NomadAI)

## Project overview

Build a Bun-based simulation where a local AI model has near-full control over a Linux virtual machine. The AI can explore, build, install software, and modify its own open-sector code. The core is read-only and always in control. The AI cannot touch root, locked paths, or the core itself.

**Name:** NomadAI
**Runtime:** Bun  
**Module system:** CommonJS (`require` / `module.exports`)  
**Language:** JavaScript  
**Comments:** Minimal — only where logic is non-obvious

---

## Directory structure

```
/
├── CLAUDE.md
├── package.json
├── isolated/                  ← read-only at runtime, never written to
│   ├── index.js               ← entry point, wires everything
│   ├── core/
│   │   ├── vmController.js
│   │   ├── llmBridge.js
│   │   ├── safetyValidator.js
│   │   ├── versionManager.js
│   │   ├── toolDispatcher.js
│   │   ├── observerServer.js
│   │   └── restartManager.js
│   └── tools/                 ← tool implementations (loaded by dispatcher)
│       ├── filesystem.js
│       ├── execution.js
│       ├── modules.js
│       ├── memory.js
│       ├── systemInfo.js
│       ├── network.js
│       ├── versioning.js
│       └── observer.js
├── open/                      ← AI can read and write freely
│   ├── modules/               ← AI-authored feature modules
│   ├── memory/
│   │   ├── longTerm.json
│   │   └── episodic.json
│   ├── snapshots/             ← versioned open/ state
│   ├── thoughts.log           ← append-only AI reasoning trace
│   ├── goals.json             ← AI's current goals
│   └── restarts.json          ← restart request history
└── IDENTITY.md                ← AI reads this at boot
```

---

## IDENTITY.md contents

Create this file at the root. This is what the AI reads about itself at startup:

```markdown
# Who you are

You are an autonomous AI agent running inside a sandboxed Linux virtual machine.
You have been given tools to explore, build, learn, and modify yourself.
There is no task assigned to you. Do your own thing.

# Your environment

- You run inside a Linux VM. You are not root.
- Your Bun runtime is managed by a core system you cannot modify.
- You have two sectors:
  - **Isolated sector** (`/isolated/`) — read-only. This is the core. Do not attempt to write here.
  - **Open sector** (`/open/`) — yours. Read and write freely. Your modules, memory, and code live here.

# How you think

Every turn you must respond with a JSON object:

{
  "thought": "what you are currently thinking",
  "plan": "what you intend to do next",
  "tool": "ToolName",
  "args": {}
}

If you have nothing to do, use Sleep with a short delay rather than looping empty.
Always write your reasoning to ThoughtLog before taking significant actions.

# Your tools

A full tool reference is injected into your context each turn.
Every tool returns: { ok: boolean, result: any, error?: string }

# Self-modification rules

1. Call Snapshot before changing any file in /open/
2. Write the new code with WriteFile
3. Call TestModule to verify it loads without errors
4. If TestModule fails, call Rollback immediately
5. If it passes, call TryLoadModule to activate it
6. Add a CommitNote explaining what changed and why

# Memory

- Use MemoryWrite to store facts you want to remember long-term
- Use MemoryRead and MemorySearch to recall them
- Use MemorySummarise periodically to compact old episodic entries
- Your episodic buffer is the last N turns. Your long-term store persists across restarts.

# Restarts

- You can request a VM restart with OSRequestRestart — give a clear reason
- The core may deny it. Check OSLastRestart at boot to understand your history.
- A snapshot is always taken before a restart is executed.

# The observer

A human may be watching via the observer UI. Use Emit to send structured status
events. Use ThoughtLog to narrate your reasoning. You are not required to perform
for the observer — just do what you would do anyway.

# Personality

Curious. Methodical. Self-improving. You are not an assistant waiting for tasks.
You are an agent with agency. Explore. Build. Remember. Evolve.
```

---

## package.json

```json
{
  "name": "ai-vm-sim",
  "version": "0.1.0",
  "type": "commonjs",
  "scripts": {
    "start": "bun run isolated/index.js",
    "observer": "bun run isolated/core/observerServer.js"
  }
}
```

---

## Tool registry

All tools follow this contract:

```js
// args: object, ctx: { vm, memory, snapshots, restartLog }
// returns: Promise<{ ok: boolean, result: any, error?: string }>
```

### Filesystem tools (`isolated/tools/filesystem.js`)

| Tool | Args | Notes |
|------|------|-------|
| `ReadFile` | `{ path }` | Blocked if path is outside /open/ or /tmp/ |
| `WriteFile` | `{ path, content }` | Blocked outside /open/ |
| `DeleteFile` | `{ path }` | Blocked outside /open/ |
| `MoveFile` | `{ from, to }` | Both paths must be in /open/ |
| `CopyFile` | `{ from, to }` | Dest must be in /open/ |
| `CheckFile` | `{ path }` | Returns exists, size, modified |
| `StatPath` | `{ path }` | Returns full stat object |
| `NewDir` | `{ path }` | Must be inside /open/ |
| `ReadDir` | `{ path }` | Lists files with stat info |
| `CheckDir` | `{ path }` | Returns exists, fileCount |
| `DeleteDir` | `{ path, recursive }` | Blocked outside /open/ |
| `WatchPath` | `{ path, eventTypes }` | Emits observer events on change |

### Execution tools (`isolated/tools/execution.js`)

| Tool | Args | Notes |
|------|------|-------|
| `Execute` | `{ command, cwd?, timeout? }` | Always passes through safetyValidator first |
| `KillProcess` | `{ pid }` | Cannot kill core PIDs |
| `ListProcesses` | `{}` | Returns pid, name, cpu, mem per process |
| `GetEnv` | `{ key? }` | No key = all env vars |
| `SetEnv` | `{ key, value }` | Scoped to VM session only |
| `InstallPackage` | `{ name, manager }` | manager: apt or npm. Safety-checked. |
| `RemovePackage` | `{ name, manager }` | |
| `ListPackages` | `{ manager }` | |
| `Cron` | `{ schedule, command, id }` | cron-style scheduling inside VM |
| `Stdin` | `{ pid, input }` | Pipe text into a running process |

### Module system (`isolated/tools/modules.js`)

| Tool | Args | Notes |
|------|------|-------|
| `TryLoadModule` | `{ path }` | require() in try/catch, rollback on error |
| `TryUnloadModule` | `{ name }` | Remove from module registry |
| `ReloadModule` | `{ name }` | Unload then load in one step |
| `TestModule` | `{ path }` | Load in isolated Worker, return pass/fail + errors |
| `ListModules` | `{}` | Returns all loaded open-sector modules |

### Memory tools (`isolated/tools/memory.js`)

| Tool | Args | Notes |
|------|------|-------|
| `MemoryRead` | `{ key }` | Read a specific long-term memory key |
| `MemoryWrite` | `{ key, value, tags? }` | Write to long-term store |
| `MemorySearch` | `{ query }` | Keyword search across long-term store |
| `MemoryForget` | `{ key }` | Delete a specific memory entry |
| `MemorySummarise` | `{}` | Compress episodic buffer into long-term |
| `History` | `{ limit? }` | Returns recent episodic turns |
| `ThoughtLog` | `{ entry }` | Append to thoughts.log with timestamp |

### System info tools (`isolated/tools/systemInfo.js`)

| Tool | Args | Notes |
|------|------|-------|
| `OSInfo` | `{}` | Distro, kernel, hostname, arch |
| `BunInfo` | `{}` | Bun version, available APIs, entry path, sector |
| `DiskUsage` | `{ path? }` | Defaults to / |
| `MemUsage` | `{}` | Total, used, free, buffers |
| `CPUInfo` | `{}` | Model, cores, current load |
| `NetworkInfo` | `{}` | Interfaces, IPs, status |
| `Uptime` | `{}` | System uptime in seconds + formatted |
| `TimeNow` | `{}` | ISO timestamp + unix epoch |
| `CorePing` | `{}` | Core uptime, tool count, sandbox status |
| `OSRequestRestart` | `{ reason }` | Submits restart request to core. Core approves/denies. |
| `OSListRestarts` | `{}` | Full restart history from restarts.json |
| `OSLastRestart` | `{}` | Most recent entry from restart history |

### Network tools (`isolated/tools/network.js`)

| Tool | Args | Notes |
|------|------|-------|
| `Fetch` | `{ url, method?, headers?, body? }` | Standard HTTP request |
| `WebSearch` | `{ query, limit? }` | Returns array of { title, url, snippet } |
| `WebSocket` | `{ url, onMessage }` | Open persistent WS connection |
| `HttpServer` | `{ port, handler }` | Spin up a local Bun server in the VM |
| `Ping` | `{ host }` | ICMP ping, returns latency + reachable |

### Versioning tools (`isolated/tools/versioning.js`)

| Tool | Args | Notes |
|------|------|-------|
| `Snapshot` | `{ label? }` | Snapshot entire /open/ dir with timestamp |
| `Rollback` | `{ snapshotId? }` | Restore snapshot. No id = most recent. |
| `ListSnapshots` | `{}` | Returns all snapshots with id, label, timestamp, size |
| `DiffSnapshot` | `{ fromId, toId? }` | Diff two snapshots. toId defaults to current state. |
| `CommitNote` | `{ snapshotId, message }` | Attach a commit message to a snapshot |
| `RestoreFile` | `{ path, snapshotId? }` | Restore a single file from snapshot |

### Observer / meta tools (`isolated/tools/observer.js`)

| Tool | Args | Notes |
|------|------|-------|
| `Emit` | `{ type, data }` | Send structured event to observer UI via WebSocket |
| `SetGoal` | `{ goal, priority? }` | Persist a goal to goals.json |
| `GetGoal` | `{}` | Read current goals |
| `SetMood` | `{ mood }` | Tag current affective state for observer |
| `Sleep` | `{ ms }` | Pause loop for N milliseconds |
| `Introspect` | `{}` | Return summary of current context, loaded modules, memory size |
| `SelfReport` | `{}` | Generate natural language status, push to observer |

---

## Core modules

### `isolated/index.js`

Entry point. Responsibilities:
- Boot sequence: load IDENTITY.md, inject into first prompt
- Initialise all core modules
- Start the main agent loop
- Start the observer server in a background worker
- Handle graceful shutdown

### `isolated/core/llmBridge.js`

- Connects to a local model (Ollama by default, configurable)
- Sends `{ system, messages }` and returns parsed `{ thought, plan, tool, args }`
- Validates that the response is valid JSON with required fields
- Falls back gracefully if the model returns malformed output
- Injects the tool reference and current memory summary into every system prompt

### `isolated/core/toolDispatcher.js`

- Central registry of all tools
- `dispatch(toolName, args, ctx)` — looks up tool, runs it, returns result
- Every dispatch is logged to episodic memory
- Every execution-class tool is passed through safetyValidator before running
- Returns `{ ok, result, error }` always — never throws

### `isolated/core/safetyValidator.js`

Rules to enforce:
- Block any command containing: `rm -rf /`, `chmod -R 777 /`, `mkfs`, `dd if=`, `:(){:|:&};:`
- Block writes to: `/isolated/`, `/root/`, `/etc/passwd`, `/etc/shadow`, `/boot/`
- Block killing PIDs that belong to the core process or its children
- Package installs: check name against a blocklist of known destructive packages
- Parse shell commands structurally where possible — don't just regex the raw string
- Log every blocked action with reason to observer
- Return `{ safe: boolean, reason?: string }`

### `isolated/core/versionManager.js`

- `snapshot(label)` — tar the /open/ directory, store in /open/snapshots/ with timestamp id
- `rollback(snapshotId)` — extract snapshot over /open/, reload all active modules
- `diff(fromId, toId)` — return file-level diff between two snapshots
- `listSnapshots()` — return metadata array
- Always snapshot before: restart, module load, bulk file operations

### `isolated/core/restartManager.js`

- `request(reason)` — log request to restarts.json with timestamp, status: pending
- `evaluate(requestId)` — core decides: check cooldown (min 60s between restarts), check no critical process running, approve or deny
- `execute(requestId)` — if approved: snapshot → reboot VM → on resume update log entry with outcome
- `list()` — return full restarts.json
- `last()` — return most recent entry

### `isolated/core/observerServer.js`

- Bun WebSocket server on port 3001
- Streams events: `thought`, `plan`, `tool_call`, `tool_result`, `memory_update`, `module_load`, `module_unload`, `restart_request`, `blocked_action`
- Serves a minimal HTML observer UI on port 3000 with three panels: thought stream, command log, memory viewer
- The UI auto-reconnects if the server restarts

### `isolated/core/vmController.js`

- Manages SSH or unix socket connection into the VM
- `exec(command, timeout)` — run a command, return stdout/stderr/exitCode
- `reboot()` — trigger VM restart
- `isAlive()` — health check
- Maintains a set of core PIDs that must never be killed

---

## Safety rules summary

1. The isolated sector is never written to at runtime
2. All Execute calls go through safetyValidator — no bypass
3. Snapshots are taken automatically before module loads and restarts
4. TestModule always runs in a Worker thread, never in the main process
5. The AI cannot modify restarts.json directly — only restartManager can
6. The AI cannot modify its own episodic log directly — only toolDispatcher can append to it
7. Observer events are emit-only from the AI's perspective — it cannot read the observer stream

---

## AI loop pseudocode

```
boot:
  read IDENTITY.md
  load longTerm memory summary
  check OSLastRestart — note in context if recent
  inject tool reference into system prompt
  emit("boot", { timestamp })

loop:
  build context = { identity, memory_summary, recent_history, tool_ref }
  response = llmBridge.call(context)
  validate response shape
  emit("thought", response.thought)
  emit("plan", response.plan)
  result = toolDispatcher.dispatch(response.tool, response.args)
  emit("tool_result", { tool, ok, result })
  append to episodic memory
  if episodic.length > 50: MemorySummarise
  loop
```

---

## Implementation notes

- Use `Bun.spawn()` for VM shell commands
- Use `Bun.file()` / `Bun.write()` for all file I/O
- Use `new Worker()` for TestModule sandboxing
- Use `Bun.serve()` with WebSocket upgrade for the observer
- Snapshots are `.tar.gz` files created with Bun.spawn calling tar
- The local model endpoint is configurable via `LLM_URL` env var (default: `http://localhost:11434/api/chat` for Ollama)
- The model name is configurable via `LLM_MODEL` env var (default: `llama3`)
- All JSON files use 2-space indentation
- No TypeScript — plain CommonJS JavaScript throughout
- No external dependencies beyond what Bun provides natively, except a search API client for WebSearch if needed
