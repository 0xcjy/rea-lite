import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

export async function validate(h) {
  const attempt = async action => {
    try { return await action(); }
    catch (error) { await h.record(error.validation || { name: 'JavaScript validation setup', status: 'failed', reason: error.stack || error.message }); }
  };
  const providers = await h.call(['providers', '--format', 'json']);
  await writeFile(path.join(h.work, 'providers.json'), providers.stdout, { flag: 'wx' });
  await h.record({ name: 'Provider inventory (not functional coverage)', status: providers.status === 0 ? 'inventory' : 'failed', stdout_file: providers.presentation?.stdout_file, stderr_file: providers.presentation?.stderr_file, command: providers.command });
  const analyses = [];
  for (const version of ['left', 'right']) {
    const dir = path.join(h.work, version);
    await mkdir(dir);
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'rea-lite-validation', main: 'main.cjs' }), { flag: 'wx' });
    await writeFile(path.join(dir, 'main.cjs'), `exports.create = function create(input) { return { kind: 'ok', value: input${version === 'right' ? ', enabled: true' : ''} }; };\nexports.version = '${version}';\n`, { flag: 'wx' });
    const result = await h.check(`JS static analysis ${version}`, ['analyze-javascript-application', dir, '--format', 'json'], data => {
      assert.equal(data.operation, 'analyze_javascript_application');
      assert.equal(data.normalized_result.statistics.parsed_javascript_files, 1);
      assert.equal(data.normalized_result.statistics.parse_failures, 0);
      assert(data.normalized_result.graph.nodes.some(node => node.kind === 'javascript-module'));
      assert(data.normalized_result.semantic_graph.nodes.some(node => node.kind === 'parameter' && node.label === 'input'));
      return { parsed_files: 1, fixture: 'Known exported create(input), literal ok discriminator, right adds enabled:true', static_only: true };
    });
    analyses.push(result.data);
  }
  const [left, right] = analyses;
  const inline = { kind: 'inline', evidence: left };
  for (const kind of ['summary', 'page']) {
    await attempt(async () => {
      const input = await h.input(`js-${kind}`, { source: inline, view: kind === 'summary' ? { kind } : { kind, collection: 'modules', offset: 0, limit: 16 } });
      const result = await h.check(`JS ${kind} from complete saved Evidence`, ['inspect-analysis-view', input, '--format', 'json'], data => {
        assert.equal(data.normalized_result.parent_evidence_id, left.evidence_id);
        if (kind === 'page') assert(data.normalized_result.items.some(item => item.path === 'main.cjs'));
        else assert.equal(data.normalized_result.summary.statistics.parsed_javascript_files, 1);
        return { parent_evidence_id: left.evidence_id };
      });
      if (kind === 'page') {
        const selected = result.data.normalized_result.items.find(item => item.path === 'main.cjs' && item.kind === 'javascript-module');
        assert(selected);
        const itemInput = await h.input('js-item', { source: inline, view: { kind: 'item', collection: 'modules', selector: { node_id: selected.node_id } } });
        await h.check('JS module item exact node identity', ['inspect-analysis-view', itemInput, '--format', 'json'], data => {
          assert.equal(data.normalized_result.parent_evidence_id, left.evidence_id);
          assert.equal(data.normalized_result.item.node_id, selected.node_id);
          assert.equal(data.normalized_result.item.path, 'main.cjs');
          assert(data.normalized_result.item.observations.some(observation => observation.evidence?.state === 'observed'));
          return { node_id: selected.node_id, path: 'main.cjs' };
        });
      }
    });
  }
  await attempt(async () => {
    const input = await h.input('js-compare', { left, right });
    await h.check('JS version comparison identifies changed fixture', ['compare-application-versions', input, '--format', 'json'], data => {
      const result = data.normalized_result;
      assert.equal(result.left.evidence_id, left.evidence_id);
      assert.equal(result.right.evidence_id, right.evidence_id);
      assert.notEqual(result.left.root_artifact_sha256, result.right.root_artifact_sha256);
      assert(result.items.some(item => ['added', 'removed', 'changed'].includes(item.status)));
      return result.summary;
    });
  });
  await attempt(async () => {
    const input = await h.input('js-shape', { left, right, left_module_path: 'main.cjs', right_module_path: 'main.cjs', left_export_name: 'create', right_export_name: 'create' });
    await h.check('JS export shape identifies added enabled field', ['compare-javascript-export-shapes', input, '--format', 'json'], data => {
      const result = data.normalized_result;
      assert.equal(result.left.status, 'selected');
      assert.equal(result.right.status, 'selected');
      assert(result.changes.some(change => change.path === '/enabled' && change.status === 'added'));
      return { changes: result.changes.map(change => ({ path: change.path, status: change.status })), coverage: result.coverage };
    });
  });
  await attempt(async () => {
    const input = await h.input('js-feature', { application: left, seed: { kind: 'module', value: 'main.cjs', match: 'exact' }, direction: 'outgoing' });
    await h.check('JS module feature trace', ['trace-application-feature', input, '--format', 'json'], data => {
      const result = data.normalized_result;
      assert.equal(result.source_evidence_id, left.evidence_id);
      assert(result.summary.matched_seeds > 0);
      assert(result.summary.traced_edges > 0);
      return result.summary;
    });
  });
  await attempt(async () => {
    const parameter = left.normalized_result.semantic_graph.nodes.find(node => node.kind === 'parameter' && node.label === 'input');
    const input = await h.input('js-semantic', { application: left, query: { seed: { kind: 'semantic-node', node_id: parameter.node_id }, direction: 'forward-influence' } });
    await h.check('JS parameter forward influence', ['trace-javascript-semantics', input, '--format', 'json'], data => {
      const result = data.normalized_result;
      assert.equal(result.source_evidence_id, left.evidence_id);
      assert(result.seed_node_ids.includes(parameter.node_id));
      assert(result.summary.traversed_relations > 0);
      return { summary: result.summary, coverage: result.coverage, static_only: true };
    });
  });
  await attempt(async () => {
    const database = path.join(h.work, 'fixture.sqlite');
    const create = spawnSync(h.node, ['--input-type=module', '-e', "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec(\"CREATE TABLE known(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO known VALUES (7, 'REA_LITE_SQLITE');\"); db.close();", database], { encoding: 'utf8' });
    assert.equal(create.status, 0, create.stderr);
    const argv = ['inspect-sqlite-database', database, '--table', 'known', '--column', 'id', '--column', 'label', '--format', 'json'];
    const result = await h.call(argv);
    if (result.status !== 0 && /DatabaseSync\.limits|Node\.js 24|unsupported_version/.test(result.stderr + result.stdout)) {
      await h.record({ name: 'SQLite known table and row', status: 'blocked', reason: result.stderr || result.stdout, command: argv, stdout_file: result.presentation.stdout_file, stderr_file: result.presentation.stderr_file });
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.data.operation, 'inspect_sqlite_database');
      const inspected = result.data.normalized_result;
      assert.equal(inspected.schema.tables.find(table => table.name === 'known').columns[0].name, 'id');
      assert.equal(inspected.rows.table, 'known');
      assert.deepEqual(inspected.rows.columns, ['id', 'label']);
      assert.equal(inspected.rows.returned_rows, 1);
      assert.equal(inspected.rows.values[0][0].type, 'integer');
      assert.equal(inspected.rows.values[0][0].value, '7');
      assert.equal(inspected.rows.values[0][1].type, 'text');
      assert.equal(inspected.rows.values[0][1].value, 'REA_LITE_SQLITE');
      await h.record({ name: 'SQLite known table and row', status: 'passed', command: argv, stdout_file: result.presentation.stdout_file, stderr_file: result.presentation.stderr_file, evidence_id: result.data.evidence_id, facts: { id: 7, label: 'REA_LITE_SQLITE' } });
    }
  });
  await attempt(async () => {
    const scenario = await h.input('owned-process', { executable: h.node, arguments: ['-e', "process.stdout.write('REA_LITE_PROCESS\\n'); process.exitCode=3;"], working_directory: h.work, timeout_ms: 5000, settle_ms: 200 });
    try {
      await h.check('Owned process PTY capture exit and output', ['capture-process', scenario, '--format', 'json'], data => {
        const result = data.normalized_result;
        assert.equal(result.exit.code, 3);
        assert(result.terminal);
        assert(JSON.stringify(result.terminal).includes('REA_LITE_PROCESS'));
        return { exit: result.exit, owned_fixture: true };
      });
    } catch (error) {
      if (!/Windows PTY process capture is unavailable/.test(error.message)) throw error;
      await h.record({ ...error.validation, status: 'blocked' });
    }
  });
  await attempt(async () => {
    const runtimeFile = path.join(h.work, 'owned-runtime.cjs');
    await writeFile(runtimeFile, "globalThis.REA_LITE_OWNED_RUNTIME = true; setInterval(() => {}, 1000);\n", { flag: 'wx' });
    const runtime = spawn(h.node, ['--inspect=127.0.0.1:0', runtimeFile], { cwd: h.work, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let startup = '';
    const endpoint = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Owned Inspector did not become ready')), 10000);
      runtime.once('error', error => { clearTimeout(deadline); reject(error); });
      runtime.stderr.on('data', chunk => {
        startup += chunk.toString();
        const match = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(startup);
        if (match) { clearTimeout(deadline); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      runtime.once('exit', code => { clearTimeout(deadline); reject(new Error(`Owned Inspector exited early: ${code}`)); });
    }).catch(error => { runtime.kill(); throw error; });
    const closed = once(runtime, 'close');
    try {
      const targets = await h.check('Owned Node Inspector discovery', ['list-javascript-runtime-targets', endpoint, '--format', 'json'], data => {
        assert.equal(data.normalized_result.targets.length, 1);
        assert.equal(data.normalized_result.targets[0].protocol_type, 'node');
        assert(data.normalized_result.targets[0].target_id);
        return { endpoint, owned_fixture: true };
      });
      const target = targets.data.normalized_result.targets[0];
      await h.check('Owned Node passive runtime observation', ['observe-javascript-runtime', endpoint, target.target_id, '--runtime-kind', 'node', '--observation-ms', '100', '--format', 'json'], data => {
        const result = data.normalized_result;
        assert.equal(data.operation, 'observe_javascript_runtime');
        assert.equal(result.target.target_id, target.target_id);
        assert.equal(result.capture.observation_ms, 100);
        assert(result.scripts.items.some(script => script.status === 'observed-loaded' && script.location?.specifier === 'node:internal/errors'));
        return { endpoint, target_id: target.target_id, events_observed: result.capture.events_observed, location: result.target.location, owned_fixture: true, limitation: 'Isolated owned Node fixture; unresolved Windows file location is not authenticated filesystem identity; not browser or Electron coverage' };
      });
    } finally { runtime.kill(); await closed; }
  });
}
