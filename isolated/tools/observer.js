const fs = require('fs');
const path = require('path');

const OPEN_DIR = path.resolve(__dirname, '../../../open');
const GOALS_FILE = path.join(OPEN_DIR, 'goals.json');

let _broadcast = null;

function setBroadcast(fn) {
  _broadcast = fn;
}

function loadGoals() {
  try { return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); } catch (_) { return []; }
}

function saveGoals(goals) {
  fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2));
}

async function Emit({ type, data }) {
  if (_broadcast) _broadcast({ type, data });
  return { ok: true, result: 'emitted' };
}

async function SetGoal({ goal, priority = 'normal' }) {
  const goals = loadGoals();
  const entry = { goal, priority, createdAt: new Date().toISOString() };
  goals.push(entry);
  saveGoals(goals);
  return { ok: true, result: entry };
}

async function GetGoal() {
  return { ok: true, result: loadGoals() };
}

async function SetMood({ mood }) {
  if (_broadcast) _broadcast({ type: 'mood', data: { mood } });
  return { ok: true, result: mood };
}

async function Sleep({ ms }) {
  await new Promise((r) => setTimeout(r, ms));
  return { ok: true, result: `Slept ${ms}ms` };
}

async function Introspect() {
  const dispatcher = require('../core/toolDispatcher');
  const memMod = require('./memory');
  const ltResult = await memMod.MemoryRead({ key: '_episodic_summary' });
  const modulesResult = await require('./modules').ListModules();

  return {
    ok: true,
    result: {
      tools: dispatcher.listTools().length,
      loadedModules: modulesResult.result,
      memorySummary: ltResult.result,
      uptime: process.uptime(),
    },
  };
}

async function SelfReport() {
  const introspect = await Introspect();
  const report = `NomadAI status at ${new Date().toISOString()}: uptime=${Math.floor(introspect.result.uptime)}s, tools=${introspect.result.tools}, modules=${introspect.result.loadedModules.length}`;
  if (_broadcast) _broadcast({ type: 'self_report', data: report });
  return { ok: true, result: report };
}

module.exports = { Emit, SetGoal, GetGoal, SetMood, Sleep, Introspect, SelfReport, setBroadcast };
