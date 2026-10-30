import { createReadStream, createWriteStream } from 'node:fs';
import { access, appendFile, mkdir, mkdtemp, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Provider configuration belongs to the machine, not the portable skill.
 * An optional JSON object at ~/.rea-lite/env.json (or REA_LITE_ENV_FILE)
 * supplies variables the caller's process did not already define.
 */
async function applyEnvironment() {
  const explicit = process.env.REA_LITE_ENV_FILE;
  const file = explicit || path.join(os.homedir(), '.rea-lite', 'env.json');
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && !explicit) return null;
    throw new Error(`Cannot read REA_LITE_ENV_FILE ${file}: ${error.message}`);
  }
  let values;
  try { values = JSON.parse(text); }
  catch (error) { throw new Error(`Invalid JSON in ${file}: ${error.message}`); }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${file} must contain a JSON object of string values`);
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') throw new Error(`${file}: ${key} must be a string`);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return file;
}
const isJS = file => /\.(?:mjs|cjs|js)$/i.test(file);
async function entryBackend(file) {
  file = path.resolve(file);
  if (!(await stat(file)).isFile()) throw new Error(`Not a regular backend file: ${file}`);
  if (/\.(?:cmd|bat)$/i.test(file)) throw new Error(`Shell launchers are not accepted: ${file}`);
  return isJS(file) ? { program: process.execPath, entry: file } : { program: file, entry: null };
}
async function packageBackend(packageFile) {
  const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
  const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.rea;
  if (typeof entry !== 'string' || !entry) throw new Error(`Missing public bin.rea in ${packageFile}`);
  return entryBackend(path.resolve(path.dirname(packageFile), entry));
}
async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}
export async function resolveBackend() {
  if (Object.hasOwn(process.env, 'REA_LITE_REA')) {
    if (!process.env.REA_LITE_REA) throw new Error('REA_LITE_REA is empty');
    return entryBackend(process.env.REA_LITE_REA);
  }
  for (let dir = scriptDir; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'node_modules', 'rea-agents', 'package.json');
    if (await exists(pkg)) return packageBackend(pkg);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const names = process.platform === 'win32' ? ['rea.cmd', 'rea.exe', 'rea'] : ['rea'];
    for (const name of names) {
      const candidate = path.resolve(dir, name);
      if (!(await exists(candidate))) continue;
      if (name === 'rea.cmd') {
        const pkg = path.join(dir, 'node_modules', 'rea-agents', 'package.json');
        if (await exists(pkg)) return packageBackend(pkg);
        continue;
      }
      const file = await realpath(candidate);
      if (!isJS(file)) {
        // Windows' extensionless npm shim is a shell script, not a native binary.
        if (process.platform === 'win32' && name === 'rea') continue;
        await access(file, constants.X_OK);
      }
      return entryBackend(file);
    }
  }
  throw new Error('REA not found; set REA_LITE_REA to an installed REA public JS entry or native executable');
}

class Preview extends Transform {
  constructor(limit) {
    super();
    this.limit = limit;
    this.decoder = new StringDecoder('utf8');
    this.text = '';
    this.count = 0;
    this.truncated = false;
    this.pending = '';
  }
  collect(text, final = false) {
    text = this.pending + text;
    this.pending = '';
    if (!final && text.length && /[\uD800-\uDBFF]/.test(text.at(-1))) {
      this.pending = text.at(-1);
      text = text.slice(0, -1);
    }
    for (const point of text) {
      if (this.count < this.limit) { this.text += point; this.count++; }
      else { this.truncated = true; break; }
    }
  }
  _transform(chunk, encoding, callback) {
    this.collect(this.decoder.write(chunk));
    callback(null, chunk);
  }
  _flush(callback) { this.collect(this.decoder.end(), true); callback(); }
}

export async function capture(argv) {
  const env_file = await applyEnvironment();
  const backend = await resolveBackend();
  const cwd = process.cwd();
  const root = path.join(cwd, '.rea-lite', 'runs');
  await mkdir(root, { recursive: true });
  const run_dir = await mkdtemp(path.join(root, 'run-'));
  const stdout_file = path.join(run_dir, 'stdout.txt');
  const stderr_file = path.join(run_dir, 'stderr.txt');
  const meta_file = path.join(run_dir, 'meta.json');
  // Both destinations must exist before anything can execute.
  const outHandle = await open(stdout_file, 'wx');
  let errHandle;
  try { errHandle = await open(stderr_file, 'wx'); }
  catch (error) { await outHandle.close(); throw error; }
  const out = createWriteStream(stdout_file, { fd: outHandle.fd, autoClose: false });
  const err = createWriteStream(stderr_file, { fd: errHandle.fd, autoClose: false });
  const stdout = new Preview(4096);
  const stderr = new Preview(1024);
  const failures = [];
  let exit_code = null;
  let signal = null;
  let child;
  try {
    child = spawn(backend.program, backend.entry ? [backend.entry, ...argv] : argv, { shell: false, cwd, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => {
      child.on('error', error => failures.push(error));
      child.on('close', (code, sig) => { exit_code = code; signal = sig; resolve(); });
    });
    const save = async (source, preview, destination) => {
      try { await pipeline(source, preview, destination); }
      catch (error) { failures.push(error); child.kill(); }
    };
    await Promise.all([closed, save(child.stdout, stdout, out), save(child.stderr, stderr, err)]);
  } catch (error) { failures.push(error); }
  finally {
    await Promise.all([outHandle.close(), errHandle.close()]).catch(error => failures.push(error));
  }
  if (failures.length) {
    const message = `REA capture failed: ${failures.map(error => error.message).join('; ')}\n`;
    await appendFile(stderr_file, message);
    stderr.collect(message, true);
  }
  const completed = failures.length === 0;
  await writeFile(meta_file, JSON.stringify({ command: argv, cwd, backend, env_file, exit_code, signal, stdout_file, stderr_file, completed }, null, 2), { flag: 'wx' });
  return {
    run_dir, stdout_file, stderr_file, meta_file, exit_code, signal,
    stdout_preview: stdout.text, stderr_preview: stderr.text,
    stdout_truncated: stdout.truncated, stderr_truncated: stderr.truncated,
    next_stdout_offset: stdout.count, next_stderr_offset: stderr.count,
    ...(stdout.truncated || stderr.truncated ? { notice: 'Incomplete preview; use read on the saved file with next offset.' } : {}),
    ...(!completed ? { error: failures.map(error => error.message).join('; ') } : {})
  };
}

export async function readWindow(file, offset, limit) {
  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${file}`);
    const stream = handle.createReadStream({ encoding: 'utf8', autoClose: false, highWaterMark: 16384 });
    let position = 0;
    let text = '';
    let count = 0;
    let more = false;
    let pending = '';
    const consume = chunk => {
      for (const point of chunk) {
        if (position++ < offset) continue;
        if (count === limit) { more = true; return; }
        text += point;
        count++;
      }
    };
    try {
      for await (let chunk of stream) {
        chunk = pending + chunk;
        pending = '';
        if (/[\uD800-\uDBFF]/.test(chunk.at(-1) || '')) { pending = chunk.at(-1); chunk = chunk.slice(0, -1); }
        consume(chunk);
        if (more) break;
      }
      if (!more && pending) consume(pending);
    } finally { stream.destroy(); }
    return { file: path.resolve(file), offset, text, next_offset: offset + count, eof: !more };
  } finally { await handle.close(); }
}

export async function commandCatalog(file) {
  // Root help is retained on disk; parse incrementally without loading it all.
  const { createInterface } = await import('node:readline');
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const commands = [];
  let inCommands = false;
  for await (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (/^Commands:\s*$/.test(line)) { inCommands = true; continue; }
    if (!inCommands) continue;
    if (/^\S/.test(line) && line.trim()) break;
    const match = /^\s{2,}([a-z][a-z0-9-]*)(?:\s+[^ ]+)*?\s{2,}(.+)$/.exec(line);
    if (match) commands.push({ command: match[1], description: match[2].trim() });
  }
  if (!inCommands || !commands.length) throw new Error(`Cannot parse REA Commands section; full help: ${file}`);
  return commands;
}
