import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, cp, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(root, 'skills', 'rea-lite');
const script = path.join(skill, 'scripts', 'rea-lite.mjs');
const backendSource = `import fs from 'node:fs';
const a=process.argv.slice(2);
fs.appendFileSync('invocations.jsonl',JSON.stringify(a)+'\\n');
if(a[0]==='--help') {
 if(process.env.BAD_HELP) console.log('Unrecognized catalog '+ 'SECRET'.repeat(1000));
 else console.log('Usage: rea\\n\\nCommands:\\n'+Array.from({length:20},(_,i)=>'  inspect-kind-'+i+' <path>  Static artifact metadata '+i).join('\\n')+'\\n\\nOptions:\\n  --help  help');
} else if(a[0]==='large') {
 process.stdout.write(Buffer.from('中文😀'.repeat(9000)));
 process.stderr.write(Buffer.from('错误🧪'.repeat(3000)));
} else if(a[0]==='fail') { console.error('deliberate failure 中文'); process.exitCode=7;
} else if(a[0]==='args') {
 // Save an evidence-shaped record AND the original argv independently.
 fs.writeFileSync('received.json',JSON.stringify(a.slice(1)));
 console.log(JSON.stringify({subject:{path:a[1]},arguments:a.slice(1),payload:'证据😀'.repeat(5000)}));
} else if(a[0]==='env') { console.log(JSON.stringify({value:process.env.REA_LITE_TEST_VALUE ?? null}));
} else { console.log(JSON.stringify({command:a})); }
`;
async function setup(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rea-lite-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const backend = path.join(cwd, 'backend with 空格.mjs');
  await writeFile(backend, backendSource);
  const env = { ...process.env, REA_LITE_REA: backend };
  delete env.REA_LITE_TEST_VALUE;
  delete env.REA_LITE_ENV_FILE;
  const invoke = (args, changes = {}, entry = script, working = cwd) => spawnSync(process.execPath, [entry, ...args], { cwd: working, env: { ...env, ...changes }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  return { cwd, backend, invoke };
}
const json = result => { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); };

test('complete bytes, bounded code points, independent runs and failure exit', async t => {
  const { invoke } = await setup(t);
  const first = json(invoke(['run', '--', 'large']));
  const second = json(invoke(['run', '--', 'large']));
  assert.notEqual(first.run_dir, second.run_dir);
  for (const result of [first, second]) {
    assert.deepEqual(await readFile(result.stdout_file), Buffer.from('中文😀'.repeat(9000)));
    assert.deepEqual(await readFile(result.stderr_file), Buffer.from('错误🧪'.repeat(3000)));
    assert.equal(Array.from(result.stdout_preview).length, 4096);
    assert.equal(Array.from(result.stderr_preview).length, 1024);
    assert.equal(result.next_stdout_offset, 4096);
    assert.equal(result.next_stderr_offset, 1024);
    assert.equal(result.stdout_truncated, true);
    assert.equal(result.stderr_truncated, true);
    assert.equal(JSON.parse(await readFile(result.meta_file)).completed, true);
  }
  const failed = invoke(['run', '--', 'fail']);
  assert.equal(failed.status, 7);
  const failure = JSON.parse(failed.stdout);
  assert.equal(await readFile(failure.stderr_file, 'utf8'), 'deliberate failure 中文\n');
  assert.equal(JSON.parse(await readFile(failure.meta_file)).exit_code, 7);
});

test('argument arrays are shell-free, evidence is complete and runs isolated', async t => {
  const { cwd, invoke } = await setup(t);
  const args = ['path with spaces 中文', '"quoted"', ';', '&', 'x & echo BAD > side-effect.txt', '$(touch side-effect.txt)'];
  const first = json(invoke(['run', '--', 'args', ...args]));
  const second = json(invoke(['run', '--', 'args', ...args]));
  assert.notEqual(first.run_dir, second.run_dir);
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'received.json'))), args);
  for (const result of [first, second]) {
    const evidence = JSON.parse(await readFile(result.stdout_file));
    assert.deepEqual(evidence.arguments, args);
    assert.equal(evidence.subject.path, args[0]);
    assert.equal(evidence.payload, '证据😀'.repeat(5000));
    assert.deepEqual(JSON.parse(await readFile(result.meta_file)).command, ['args', ...args]);
  }
  await assert.rejects(stat(path.join(cwd, 'side-effect.txt')), { code: 'ENOENT' });
});

test('invalid backend and unavailable output destination never execute backend', async t => {
  const { cwd, backend, invoke } = await setup(t);
  for (const selected of [path.join(cwd, 'absent.mjs'), cwd, path.join(cwd, 'rea.cmd')]) {
    if (selected.endsWith('.cmd')) await writeFile(selected, 'echo BAD');
    const result = invoke(['run', '--', 'large'], { REA_LITE_REA: selected });
    assert.equal(result.status, 1);
    assert(JSON.parse(result.stderr).error);
  }
  await mkdir(path.join(cwd, '.rea-lite'));
  await writeFile(path.join(cwd, '.rea-lite', 'runs'), 'blocks directory creation');
  assert.equal(invoke(['run', '--', 'large'], { REA_LITE_REA: backend }).status, 1);
  await assert.rejects(stat(path.join(cwd, 'invocations.jsonl')), { code: 'ENOENT' });
});

test('read pages reconstruct cross-chunk Unicode and preserve EOF semantics', async t => {
  const { cwd, invoke } = await setup(t);
  const file = path.join(cwd, 'unicode.txt');
  const original = 'a'.repeat(16382) + '😀中文🧪'.repeat(4100);
  await writeFile(file, original);
  let offset = 0;
  let recovered = '';
  while (true) {
    const page = json(invoke(['read', file, '--offset', String(offset), '--limit', '8191']));
    recovered += page.text;
    assert.equal(page.next_offset, offset + Array.from(page.text).length);
    offset = page.next_offset;
    if (page.eof) break;
  }
  assert.equal(recovered, original);
  for (const position of [offset, offset + 100]) {
    const page = json(invoke(['read', file, '--offset', String(position)]));
    assert.equal(page.text, ''); assert.equal(page.eof, true); assert.equal(page.next_offset, position);
  }
  const exact = path.join(cwd, 'exact.txt');
  await writeFile(exact, '😀中');
  assert.equal(json(invoke(['read', exact, '--limit', '2'])).eof, true);
  for (const args of [[file, '--limit', '0'], [file, '--offset', '-1'], [file, '--limit', '8193'], [file, '--offset', '1.5'], [file, '--unknown', '1'], [file, '--offset'], [cwd], [path.join(cwd, 'missing')]]) assert.notEqual(invoke(['read', ...args]).status, 0);
  await assert.rejects(stat(path.join(cwd, 'invocations.jsonl')), { code: 'ENOENT' });
});

test('find bounds literal all-word matches and rejects unknown help format', async t => {
  const { invoke } = await setup(t);
  const many = json(invoke(['find', 'STATIC metadata']));
  assert.equal(many.matched, 20); assert.equal(many.returned, 12);
  assert.deepEqual(many.matches.map(m => m.command), Array.from({ length: 12 }, (_, i) => `inspect-kind-${i}`));
  assert(!Object.hasOwn(many, 'stdout_preview'));
  assert.equal(json(invoke(['find', 'metadata', '19'])).matches[0].command, 'inspect-kind-19');
  assert.deepEqual(json(invoke(['find', '.*'])).matches, []);
  const bad = invoke(['find', 'static'], { BAD_HELP: '1' });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stderr).error, /stdout\.txt/);
  assert(!bad.stdout.includes('SECRET'));
});

test('invalid wrapper input and short help never start backend', async t => {
  const { cwd, invoke } = await setup(t);
  for (const args of [['run'], ['run', '--'], ['run', '--', '--mcp'], ['run', '--', 'mcp'], ['help', '../bad'], ['schema', '--help'], ['help', 'x', 'extra'], ['unknown']]) assert.equal(invoke(args).status, 2);
  assert.equal(invoke([]).status, 0);
  assert.equal(invoke(['find']).status, 0);
  await assert.rejects(stat(path.join(cwd, 'invocations.jsonl')), { code: 'ENOENT' });
});

test('copied skill works from unrelated cwd and entry stays within budgets', async t => {
  const { cwd, invoke } = await setup(t);
  const copy = path.join(cwd, '可复制 skill with spaces');
  await cp(skill, copy, { recursive: true });
  const elsewhere = path.join(cwd, 'other cwd');
  await mkdir(elsewhere);
  const result = json(invoke(['help', 'inspect-go-binary'], {}, path.join(copy, 'scripts', 'rea-lite.mjs'), elsewhere));
  assert.equal(path.dirname(path.dirname(path.dirname(result.run_dir))), elsewhere);
  assert.equal(JSON.parse(await readFile(result.meta_file)).cwd, elsewhere);
  const entry = await readFile(path.join(copy, 'SKILL.md'), 'utf8');
  assert(Buffer.byteLength(entry) <= 1800);
  assert(entry.split('---')[2].trim().split('\n').length <= 24);
});

test('machine env file supplies missing provider variables without overriding the caller', async t => {
  const { cwd, invoke } = await setup(t);
  const envFile = path.join(cwd, 'env.json');
  await writeFile(envFile, JSON.stringify({ REA_LITE_TEST_VALUE: 'from-file' }));
  const fromFile = json(invoke(['run', '--', 'env'], { REA_LITE_ENV_FILE: envFile }));
  assert.equal(JSON.parse(await readFile(fromFile.stdout_file, 'utf8')).value, 'from-file');
  assert.equal(JSON.parse(await readFile(fromFile.meta_file, 'utf8')).env_file, envFile);
  const direct = json(invoke(['run', '--', 'env'], { REA_LITE_ENV_FILE: envFile, REA_LITE_TEST_VALUE: 'from-caller' }));
  assert.equal(JSON.parse(await readFile(direct.stdout_file, 'utf8')).value, 'from-caller');
  await rm(path.join(cwd, 'invocations.jsonl'));
  const missing = invoke(['run', '--', 'env'], { REA_LITE_ENV_FILE: path.join(cwd, 'absent.json') });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /REA_LITE_ENV_FILE/);
  const malformed = path.join(cwd, 'bad.json');
  await writeFile(malformed, '{not json');
  assert.equal(invoke(['run', '--', 'env'], { REA_LITE_ENV_FILE: malformed }).status, 1);
  const typed = path.join(cwd, 'typed.json');
  await writeFile(typed, JSON.stringify({ REA_LITE_TEST_VALUE: 5 }));
  assert.equal(invoke(['run', '--', 'env'], { REA_LITE_ENV_FILE: typed }).status, 1);
  await assert.rejects(stat(path.join(cwd, 'invocations.jsonl')), { code: 'ENOENT' });
});
