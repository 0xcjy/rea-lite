#!/usr/bin/env node
import { capture, commandCatalog, readWindow } from './backend.mjs';

const help = `rea-lite: installed REA, on demand
  find <words...>                 Match up to 12 CLI commands
  help <command>                 Save command help
  schema <command>               Save command JSON schema
  run -- <command> [args...]      Save full CLI output; bounded preview
  read <file> [--offset N] [--limit N]  Read saved text (code points)
`;
const emit = value => console.log(JSON.stringify(value, null, 2));
function invalid(message) { const error = new Error(message); error.exitCode = 2; throw error; }
function integer(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) invalid(`Invalid ${name}: ${value}`);
  return Number(value);
}
async function main(args) {
  const [mode, ...rest] = args;
  if (!mode || mode === '--help') { if (rest.length) invalid('Unexpected help arguments'); console.log(help); return; }
  if (mode === 'read') {
    if (!rest.length || rest[0].startsWith('--')) invalid('read requires a file');
    let offset = 0;
    let limit = 2048;
    const seen = new Set();
    for (let index = 1; index < rest.length; index += 2) {
      const key = rest[index];
      if (!['--offset', '--limit'].includes(key) || seen.has(key)) invalid(`Unknown or repeated read argument: ${key}`);
      seen.add(key);
      if (key === '--offset') offset = integer(rest[index + 1], 'offset', 0);
      else limit = integer(rest[index + 1], 'limit', 1, 8192);
    }
    emit(await readWindow(rest[0], offset, limit));
    return;
  }
  let argv;
  let words;
  if (mode === 'find') {
    words = rest.flatMap(word => word.split(/\s+/)).filter(Boolean).map(word => word.toLowerCase());
    if (!words.length) { console.log(help); return; }
    argv = ['--help'];
  } else if (mode === 'help' || mode === 'schema') {
    if (rest.length !== 1 || !/^[a-z][a-z0-9-]*$/.test(rest[0])) invalid(`${mode} requires one lowercase CLI command name`);
    argv = mode === 'help' ? [rest[0], '--help'] : [rest[0], '--schema', '--format', 'json'];
  } else if (mode === 'run') {
    if (rest[0] !== '--' || rest.length < 2) invalid('Use run -- <command> [args...]');
    argv = rest.slice(1);
    if (argv[0] === '--mcp' || argv[0] === 'mcp') invalid('MCP sessions are not supported by this finite CLI entrypoint');
  } else invalid(`Unknown wrapper command: ${mode}`);
  const result = await capture(argv);
  process.exitCode = result.error || result.signal || result.exit_code === null ? 1 : result.exit_code;
  if (mode !== 'find' || process.exitCode !== 0) {
    if (mode === 'find') {
      emit({ run_dir: result.run_dir, stdout_file: result.stdout_file, stderr_file: result.stderr_file, exit_code: result.exit_code, error: result.error || 'REA help failed; inspect saved output' });
    } else emit(result);
    return;
  }
  const catalog = await commandCatalog(result.stdout_file);
  const matches = catalog.filter(item => words.every(word => `${item.command} ${item.description}`.toLowerCase().includes(word)));
  emit({ matches: matches.slice(0, 12), matched: matches.length, returned: Math.min(matches.length, 12), run_dir: result.run_dir, stdout_file: result.stdout_file, stderr_file: result.stderr_file, ...(matches.length > 12 ? { notice: 'Narrow the search words for remaining matches.' } : {}) });
}
main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = error.exitCode || 1;
});
