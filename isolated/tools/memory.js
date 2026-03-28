const fs = require('fs');
const path = require('path');

const OPEN_DIR = path.resolve(__dirname, '../../open');
const LT_FILE = path.join(OPEN_DIR, 'memory/longTerm.json');
const EP_FILE = path.join(OPEN_DIR, 'memory/episodic.json');
const THOUGHTS_FILE = path.join(OPEN_DIR, 'thoughts.log');

function loadLT() {
  try { return JSON.parse(fs.readFileSync(LT_FILE, 'utf8')); } catch (_) { return {}; }
}

function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function saveLT(data) {
  atomicWrite(LT_FILE, JSON.stringify(data, null, 2));
}

function loadEp() {
  try { return JSON.parse(fs.readFileSync(EP_FILE, 'utf8')); } catch (_) { return []; }
}

function saveEp(data) {
  atomicWrite(EP_FILE, JSON.stringify(data, null, 2));
}

async function MemoryRead({ key }) {
  const lt = loadLT();
  return { ok: true, result: lt[key] ?? null };
}

async function MemoryWrite({ key, value, tags = [] }) {
  const lt = loadLT();
  lt[key] = { value, tags, updatedAt: new Date().toISOString() };
  saveLT(lt);
  return { ok: true, result: 'stored' };
}

async function MemorySearch({ query }) {
  const lt = loadLT();
  const q = query.toLowerCase();
  const results = [];
  for (const [key, entry] of Object.entries(lt)) {
    const haystack = (key + JSON.stringify(entry.value) + (entry.tags || []).join(' ')).toLowerCase();
    if (haystack.includes(q)) results.push({ key, ...entry });
  }
  return { ok: true, result: results };
}

async function MemoryForget({ key }) {
  const lt = loadLT();
  if (!(key in lt)) return { ok: false, error: `Key not found: ${key}` };
  delete lt[key];
  saveLT(lt);
  return { ok: true, result: 'forgotten' };
}

async function MemorySummarise() {
  const ep = loadEp();
  if (ep.length === 0) return { ok: true, result: 'nothing to summarise' };

  const lt = loadLT();
  const summary = ep.slice(-50).map((e) => `[${e.ts}] ${e.tool}(${JSON.stringify(e.args)})`).join('\n');
  lt['_episodic_summary'] = { value: summary, tags: ['auto'], updatedAt: new Date().toISOString() };
  saveLT(lt);
  saveEp([]);
  return { ok: true, result: `Summarised ${ep.length} entries` };
}

async function History({ limit = 20 }) {
  const ep = loadEp();
  return { ok: true, result: ep.slice(-limit) };
}

async function ThoughtLog({ entry }) {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  fs.appendFileSync(THOUGHTS_FILE, line);
  return { ok: true, result: 'logged' };
}

module.exports = { MemoryRead, MemoryWrite, MemorySearch, MemoryForget, MemorySummarise, History, ThoughtLog };
