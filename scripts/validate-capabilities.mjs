#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commandCatalog } from '../skills/rea-lite/scripts/backend.mjs';
const availableFamilies = ['javascript', 'native', 'artifacts', 'browser', 'environment'];
const families = process.argv.length > 2 ? [...new Set(process.argv.slice(2))] : availableFamilies;
if (families.some(family => !availableFamilies.includes(family))) {
  console.error('Unknown validation family; use javascript, native, artifacts, browser, environment.');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, '.rea-lite', 'validation'), { recursive: true });
const work = await mkdtemp(path.join(root, '.rea-lite', 'validation', 'run-'));
const results = [];
const entry = path.join(root, 'skills', 'rea-lite', 'scripts', 'rea-lite.mjs');
const reportFile = path.join(work, 'report.json');
const helpCache = new Map();
let commandCoverage;
async function save() {
  await writeFile(reportFile, JSON.stringify({ node: process.version, work, results, command_coverage: commandCoverage }, null, 2));
}
function spawnWrapper(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', data => stdout.push(data));
    child.stderr.on('data', data => stderr.push(data));
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}
async function call(argv) {
  const processResult = await spawnWrapper(['run', '--', ...argv]);
  let presentation, data;
  try { presentation = JSON.parse(processResult.stdout); } catch { /* Wrapper failures have only stderr. */ }
  const stdout = presentation?.stdout_file ? await readFile(presentation.stdout_file, 'utf8') : processResult.stdout;
  const stderr = presentation?.stderr_file ? await readFile(presentation.stderr_file, 'utf8') : processResult.stderr;
  try { data = JSON.parse(stdout); } catch { /* Help and non-JSON errors remain original text. */ }
  return { ...processResult, stdout, stderr, data, presentation, command: argv };
}
async function record(result) {
  results.push(result);
  console.log(`${result.status}: ${result.name}${result.reason ? ` — ${result.reason}` : ''}`);
  await save();
  return result;
}
async function check(name, argv, verify) {
  return checkResult(name, await call(argv), verify);
}
async function checkResult(name, result, verify) {
  const refs = { command: result.command, stdout_file: result.presentation?.stdout_file, stderr_file: result.presentation?.stderr_file, meta_file: result.presentation?.meta_file };
  try {
    if (result.status !== 0) throw new Error(`exit ${result.status}: ${result.stderr || result.stdout}`);
    const facts = await verify(result.data, result);
    await record({ name, status: 'passed', ...refs, evidence_id: result.data?.evidence_id, subject: result.data?.subject, facts });
    return result;
  } catch (error) {
    // Callers can distinguish an observed missing prerequisite from a regression.
    error.validation = { name, status: 'failed', ...refs, reason: error.message };
    throw error;
  }
}
const h = {
  root, work, node: process.execPath, call, check, checkResult, record,
  async help(command) {
    if (!helpCache.has(command)) {
      const result = await call([command, '--help']);
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      helpCache.set(command, result.stdout);
    }
    return helpCache.get(command);
  },
  async input(name, value) {
    const file = path.join(work, name + '.json');
    await writeFile(file, JSON.stringify(value), { flag: 'wx' });
    return file;
  }
};
for (const moduleName of families) {
  try {
    const { validate } = await import(`./validation/${moduleName}.mjs`);
    await validate(h);
  } catch (error) {
    await record(error.validation || { name: moduleName, status: 'failed', reason: error.stack || error.message });
  }
}
const catalog = await call(['--help']);
if (catalog.status === 0) {
  const commands = await commandCatalog(catalog.presentation.stdout_file);
  commandCoverage = commands.map(({ command, description }) => {
    const exercised = results.filter(result => result.command?.[0] === command && !result.inventory_advisory);
    const statuses = exercised.map(result => result.status);
    return { command, description, status: statuses.includes('failed') ? 'failed' : statuses.includes('passed') ? 'passed' : statuses.includes('blocked') ? 'blocked' : statuses.includes('inventory') ? 'inventory' : 'not_tested', checks: exercised.map(result => result.name), reason: exercised.length ? undefined : 'No functional check in this run; availability/help is not a pass.' };
  });
} else await record({ name: 'CLI catalog coverage accounting', status: 'failed', reason: catalog.stderr || catalog.stdout });
await save();
console.log(JSON.stringify({ report_file: reportFile, counts: results.reduce((counts, result) => ({ ...counts, [result.status]: (counts[result.status] || 0) + 1 }), {}) }, null, 2));
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
