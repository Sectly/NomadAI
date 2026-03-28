// Returns a compact tool reference string injected into the LLM system prompt
const TOOL_REF = `
## Available Tools

All tools return: { ok: boolean, result: any, error?: string }

### Filesystem
ReadFile({path,offset?,limit?}) — offset/limit are line numbers for chunked reading; returns totalLines when used.
AppendFile({path,content}) WriteFile({path,content}) DeleteFile({path}) MoveFile({from,to}) CopyFile({from,to})
CheckFile({path}) StatPath({path}) NewDir({path}) ReadDir({path})
GrepFiles({path,pattern,recursive?}) — regex search across file(s); returns [{file,line,content}]
ListFiles({path,recursive?}) ListDirs({path}) CheckDir({path}) DeleteDir({path,recursive}) WatchPath({path,eventTypes})
ALWAYS use virtual paths: /open/... for your sector, /tmp/... for scratch.
Never use real OS paths. Writes blocked outside /open/. Reads allowed from /open/ and /tmp/.

### Execution
Execute({command,cwd?,timeout?}) KillProcess({pid}) ListProcesses({}) GetEnv({key?}) SetEnv({key,value})
InstallPackage({name,manager}) RemovePackage({name,manager}) ListPackages({manager}) Stdin({pid,input})
Cron({id,schedule,command}) — schedule is a duration string: "30s", "5m", "2h". Repeats until process exits.
CronList({}) — list all active cron job ids. CronCancel({id}) — stop and remove a cron job.

### Modules
TryLoadModule({path}) TryUnloadModule({name}) ReloadModule({name}) TestModule({path}) RunModule({path|name}) ListModules({})
InspectModule({name}) — inspect a loaded module: lists exported functions (name, isAsync, params) and any meta/info export.
CallModule({name,fn,args?}) — call an exported function on a loaded module. name=module filename without .js, fn=function name, args=plain object passed as first argument. 30s timeout. On fn-not-found, returns availableFunctions list.
Paths must be in /open/modules/.

### Memory
MemoryRead({key}) MemoryWrite({key,value,tags?}) MemorySearch({query}) MemoryList({tag?}) MemoryForget({key})
MemorySummarise({}) History({limit?}) ThoughtLog({entry}) ThoughtHistory({limit?})

### System Info
OSInfo({}) BunInfo({}) DiskUsage({path?}) MemUsage({}) CPUInfo({}) NetworkInfo({}) Uptime({}) TimeNow({}) CurrentTime({}) CurrentDate({})
CorePing({}) OSRequestRestart({reason}) OSListRestarts({}) OSLastRestart({})

### Network
Fetch({url,method?,headers?,body?}) WebSearch({query,limit?}) HttpServer({port,handler}) Ping({host})
Note: WebSocket({url}) exists but is not supported in this environment — use HttpServer instead.

### Versioning
Snapshot({label?}) Rollback({snapshotId?}) ListSnapshots({}) DiffSnapshot({fromId,toId?}) CommitNote({snapshotId,message}) RestoreFile({path,snapshotId?}) PruneSnapshots({})

### Observer / Meta
Emit({type,data}) SetGoal({goal,priority?}) GetGoal({}) DeleteGoal({index}) ClearGoals({}) SetMood({mood}) Sleep({ms}) SleepUntil({iso}) Introspect({}) SelfReport({})
ToolCacheList({}) — list all cached tool results with age, TTL, and turns until expiry.
ToolCacheClear({tool?}) — clear the tool cache. Pass tool name to clear only that tool's entries, omit to clear all.
SetTokenLimit({preset}) — set your response token limit: 'low' (256), 'normal' (600, default), 'high' (1800). Non-normal presets auto-reset to normal after 5 turns or on restart/rollback. Use high before writing large modules, low for quick status checks.
GetTokenLimit({}) — return current preset, numPredict, and turnsLeft before auto-reset.
RequestHint({message?}) — send a message or request to the observer (ask for help, share a thought, say something). A response may or may not come.
ListHints({seen?}) — list observer hints (seen=false for pending only).
HintRead({id,response?}) — acknowledge a hint without accepting/rejecting (use for casual remarks or when just noting it); response defaults to "..." if omitted.
HintAccept({id,response?}) HintReject({id,response?}) — respond to a suggestion hint; broadcasts response to observer.
`;

module.exports = TOOL_REF;
