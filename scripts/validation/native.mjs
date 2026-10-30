import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const MANAGED_SOURCE = `using System;
using System.Runtime.InteropServices;
public static class ManagedFixture
{
    public const string Marker = "REA_LITE_MANAGED";
    public static int Answer() { return 42; }
    [DllImport("kernel32.dll", EntryPoint = "GetCurrentProcessId")]
    public static extern int GetProcessId();
}
`;
const RUST_SOURCE = `pub fn marker() -> u32 { 0x5245_415F }
fn main() { let _ = marker(); }
`;
// Minimal core module exporting "one" returning i32 42: type, function, export and code sections.
const MINIMAL_WASM_HEX = '0061736d010000000105016000017f03020100070701036f6e6500000a06010400412a0b';
// Runtime: selector 0x12345678 jumps to a JUMPDEST then stores 1 at slot 0.
const EVM_HEX = '60003560e01c631234567814601057005b600160005500';

const exists = async file => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

function runProcess(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
  });
}

const hashCache = new Map();
function hashFile(file) {
  if (!hashCache.has(file)) {
    hashCache.set(file, new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(file);
      stream.on('error', reject);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    }));
  }
  return hashCache.get(file);
}

async function findOnPath(names) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

function commandRefs(result) {
  const argv = Array.isArray(result.command) ? result.command : [];
  return {
    command: argv,
    exit_code: result.status,
    signal: result.signal ?? null,
    stdout_file: result.presentation?.stdout_file,
    stderr_file: result.presentation?.stderr_file,
    meta_file: result.presentation?.meta_file
  };
}

function errorReason(result) {
  const data = result.data;
  if (data && typeof data === 'object') {
    const parts = [data.code, data.category, data.message].filter(Boolean);
    if (data.remediation?.action) parts.push(`remediation: ${data.remediation.action}`);
    return parts.join(' | ');
  }
  return (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 800);
}

async function recordBlocked(h, name, result, extra = {}) {
  const data = result.data || {};
  await h.record({
    name,
    status: 'blocked',
    reason: errorReason(result),
    ...commandRefs(result),
    error_code: data.code ?? null,
    category: data.category ?? null,
    details: data.details ?? null,
    ...extra
  });
}

async function recordFailedProbe(h, name, result, extra = {}) {
  await h.record({
    name,
    status: 'failed',
    reason: errorReason(result),
    ...commandRefs(result),
    error_code: result.data?.code ?? null,
    category: result.data?.category ?? null,
    ...extra
  });
}

const PROVIDER_BLOCKERS = new Set(['provider_unavailable', 'capability_unavailable']);
const HOST_BLOCKERS = new Set(['unsupported_provider', 'unsupported_host']);

/** Preserve actual provider errors; an available route is not semantic coverage. */
async function probeAvailability(h, { name, argv }) {
  const probe = await h.call(argv);
  if (probe.status === 0) {
    await h.record({ name, status: 'inventory', ...commandRefs(probe), evidence_id: probe.data?.evidence_id, reason: 'Provider route returned successfully; this gate probe alone does not verify decompilation/layout/interface semantics.' });
    return;
  }
  const data = probe.data || {};
  if (PROVIDER_BLOCKERS.has(data.code) || HOST_BLOCKERS.has(data.category) || data.category === 'unsupported_provider') {
    await recordBlocked(h, name, probe);
  } else {
    await recordFailedProbe(h, name, probe);
  }
}

async function inspectProviders(h) {
  const result = await h.call(['providers', '--format', 'json']);
  if (result.status !== 0) throw new Error(`providers failed: ${errorReason(result)}`);
  const inventory = result.data;
  assert.ok(inventory && Array.isArray(inventory.analysis_provider_candidates), 'providers result lacks analysis_provider_candidates');

  for (const candidate of inventory.analysis_provider_candidates) {
    const availability = candidate.availability || {};
    if (availability.status === 'available') continue;
    await h.record({
      name: `providers-native-${candidate.provider.id}`,
      status: 'blocked',
      reason: `${availability.code || availability.status}: ${availability.reason || 'unavailable'}`,
      ...commandRefs(result),
      provider_id: candidate.provider.id,
      availability_code: availability.code ?? null,
      availability_status: availability.status ?? null,
      provider_diagnostics: availability.diagnostics ?? null,
      inventory_advisory: 'Provider inventory blockers are advisory; capability commands are attempted independently below.'
    });
  }

  return inventory;
}

export async function validate(h) {
  const fixtureDir = path.join(h.work, 'native-fixtures');
  await mkdir(fixtureDir, { recursive: true });

  await inspectProviders(h);

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const ghCandidates = [
    path.join(programFiles, 'GitHub CLI', 'gh.exe'),
    await findOnPath(['gh.exe', 'gh'])
  ].filter(Boolean);
  let goFixture = null;
  for (const candidate of ghCandidates) {
    if (await exists(candidate)) {
      goFixture = candidate;
      break;
    }
  }

  if (goFixture) {
    const goSha = await hashFile(goFixture);
    await h.check('go-metadata-gh-positive', ['inspect-go-binary', goFixture, '--format', 'json'], data => {
      assert.equal(data.operation, 'inspect_go_binary');
      assert.equal(data.subject.digest.sha256, goSha);
      const build = data.normalized_result?.build_info;
      assert.ok(build, 'expected Go build information for gh.exe');
      assert.match(build.go_version, /^go1\.\d+/);
      assert.equal(build.module.path, 'github.com/cli/cli/v2/cmd/gh');
      assert.equal(build.module.main.path, 'github.com/cli/cli/v2');
      assert.ok(Array.isArray(build.module.dependencies) && build.module.dependencies.length > 20);
      return {
        fixture: path.basename(goFixture),
        target_sha256: goSha,
        go_version: build.go_version,
        module_path: build.module.path,
        main_module: build.module.main,
        dependency_count: build.module.dependencies.length,
        positive_language_evidence: true
      };
    });

    await h.check('pe-resources-gh', ['inspect-pe-resources', goFixture, '--format', 'json'], data => {
      assert.equal(data.operation, 'inspect_pe_resources');
      assert.equal(data.subject.digest.sha256, goSha);
      const result = data.normalized_result;
      assert.equal(result.coverage.status, 'complete');
      assert.equal(result.coverage.resources, result.resources.length);
      assert.ok(result.resources.length >= 1);
      const version = result.resources.find(resource => resource.type?.kind === 'id' && resource.type.id === 16);
      assert.ok(version, 'expected an RT_VERSION (type 16) resource');
      assert.match(version.payload.sha256, /^[0-9a-f]{64}$/);
      return {
        fixture: path.basename(goFixture),
        target_sha256: goSha,
        resource_count: result.resources.length,
        type_ids: [...new Set(result.resources.map(resource => resource.type?.id ?? resource.type?.kind))],
        version_payload_sha256: version.payload.sha256,
        coverage: result.coverage
      };
    });
  } else {
    await h.record({
      name: 'go-metadata-gh-positive',
      status: 'not_tested',
      reason: 'No local Go-built fixture was found (GitHub CLI gh.exe absent); Go verification remains negative-only.',
      command: ['inspect-go-binary', '<go-built PE>', '--format', 'json']
    });
  }

  await h.check('go-metadata-node-negative-only', ['inspect-go-binary', h.node, '--format', 'json'], async data => {
    assert.equal(data.operation, 'inspect_go_binary');
    assert.equal(data.subject.digest.sha256, await hashFile(h.node));
    assert.equal(data.normalized_result.build_info, null);
    return {
      fixture: path.basename(h.node),
      target_sha256: data.subject.digest.sha256,
      build_info: null,
      claim_scope: 'negative-only: absence of Go build info does not establish that the binary is not Go'
    };
  });

  await h.check('rust-metadata-node-negative-only', ['inspect-rust-binary', h.node, '--format', 'json'], async data => {
    assert.equal(data.operation, 'inspect_rust_binary');
    assert.equal(data.subject.digest.sha256, await hashFile(h.node));
    assert.equal(data.normalized_result.auditable_metadata, null);
    assert.equal(data.normalized_result.rustc_commit, null);
    return {
      fixture: path.basename(h.node),
      target_sha256: data.subject.digest.sha256,
      auditable_metadata: null,
      rustc_commit: null,
      claim_scope: 'negative-only: absence of .dep-v0 and /rustc paths does not establish a non-Rust or dependency-free binary'
    };
  });

  const rustc = await findOnPath(['rustc.exe', 'rustc']);
  let rustFixture = null;
  if (rustc) {
    const source = path.join(fixtureDir, 'rust_fixture.rs');
    rustFixture = path.join(fixtureDir, 'rust_fixture.exe');
    await writeFile(source, RUST_SOURCE);
    const build = await runProcess(rustc, ['--edition', '2021', '-O', '-o', rustFixture, source], fixtureDir);
    if (build.status !== 0) {
      throw new Error(`rustc fixture build failed (${build.status}): ${build.stderr || build.stdout}`);
    }
  } else {
    await h.record({
      name: 'rust-metadata-fixture',
      status: 'not_tested',
      reason: 'rustc was not found on PATH, so no local Rust executable could be compiled for positive metadata inspection.',
      command: ['inspect-rust-binary', '<rust-built PE>', '--format', 'json']
    });
  }

  if (rustFixture) {
    const rustSha = await hashFile(rustFixture);
    await h.check('rust-metadata-rustc-commit-inference', ['inspect-rust-binary', rustFixture, '--format', 'json'], data => {
      assert.equal(data.operation, 'inspect_rust_binary');
      assert.equal(data.subject.digest.sha256, rustSha);
      const result = data.normalized_result;
      assert.equal(result.auditable_metadata, null);
      const hashes = result.rustc_commit?.hashes || [];
      assert.ok(hashes.length >= 1, 'expected an inferred rustc commit hash');
      for (const entry of hashes) assert.match(entry.hash, /^[0-9a-f]{40}$/);
      return {
        fixture: path.basename(rustFixture),
        target_sha256: rustSha,
        rustc_commit_hash: hashes[0].hash,
        rustc_commit_evidence: result.rustc_commit.evidence_kind,
        auditable_metadata: null,
        claim_scope: 'rustc commit inference only; no cargo-auditable dependency list was present'
      };
    });

    const objdump = await findOnPath(['objdump.exe', 'objdump', 'gobjdump']);
    if (objdump) {
      await h.check('objdump-disassembly-rust-fixture', ['inspect-with-objdump', rustFixture, 'disassemble', '--format', 'json'], data => {
        assert.equal(data.operation, 'inspect_with_objdump');
        assert.equal(data.subject.digest.sha256, rustSha);
        const result = data.normalized_result;
        assert.equal(result.exit_code, 0);
        assert.equal(result.completion_status, 'complete');
        assert.equal(result.artifact_changed, false);
        assert.equal(result.artifact_sha256_after, rustSha);
        assert.equal(result.output_truncated, false);
        assert.match(result.stdout, /file format pei-x86-64/);
        assert.match(result.stdout, /Disassembly of section \.text:/);
        assert.match(result.stdout, /\bret\b/);
        return {
          fixture: path.basename(rustFixture),
          target_sha256: rustSha,
          objdump_executable: objdump,
          disassembly_bytes: result.stdout.length,
          completion_status: result.completion_status,
          artifact_changed: false
        };
      });
    } else {
      await h.record({
        name: 'objdump-disassembly-rust-fixture',
        status: 'blocked',
        reason: 'GNU objdump was not found on PATH.',
        command: ['inspect-with-objdump', rustFixture, 'disassemble', '--format', 'json']
      });
    }
  }

  const cscPath = process.platform === 'win32'
    ? path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    : null;
  if (cscPath && await exists(cscPath)) {
    const source = path.join(fixtureDir, 'ManagedFixture.cs');
    const assembly = path.join(fixtureDir, 'ManagedFixture.dll');
    await writeFile(source, MANAGED_SOURCE);
    const build = await runProcess(cscPath, ['/nologo', '/target:library', '/out:ManagedFixture.dll', 'ManagedFixture.cs'], fixtureDir);
    if (build.status !== 0) {
      throw new Error(`managed fixture build failed (${build.status}): ${build.stderr || build.stdout}`);
    }
    const managedSha = await hashFile(assembly);

    await h.check('managed-artifact-identity', ['inspect-managed-artifact', assembly, '--format', 'json'], data => {
      assert.equal(data.operation, 'inspect_managed_artifact');
      assert.equal(data.subject.digest.sha256, managedSha);
      const result = data.normalized_result;
      assert.equal(result.classification.status, 'managed');
      assert.equal(result.artifact.sha256, managedSha);
      assert.equal(result.metadata.status, 'complete');
      assert.equal(result.metadata.version, 'v4.0.30319');
      assert.equal(result.metadata.table_row_counts.MethodDef, 2);
      assert.equal(result.module.name, 'ManagedFixture.dll');
      assert.equal(result.assembly.name, 'ManagedFixture');
      assert.ok(result.references.some(reference => reference.name === 'mscorlib'));
      assert.equal(result.coverage.state, 'complete');
      return {
        fixture: path.basename(assembly),
        target_sha256: managedSha,
        mvid: result.module.mvid,
        metadata_version: result.metadata.version,
        method_def_rows: result.metadata.table_row_counts.MethodDef,
        assembly_name: result.assembly.name,
        runtime_family: result.classification.runtime_family
      };
    });

    await h.check('managed-members-il-anchors', ['inspect-managed-members', assembly, '--format', 'json'], data => {
      assert.equal(data.operation, 'inspect_managed_members');
      assert.equal(data.subject.digest.sha256, managedSha);
      const result = data.normalized_result;
      assert.equal(result.identity_scope.requires_artifact_sha256, managedSha);
      assert.equal(result.identity_scope.requires_mvid, result.module.mvid);
      assert.ok(result.types.some(type => type.full_name === 'ManagedFixture'));
      assert.ok(result.fields.some(field => field.name === 'Marker' && field.signature.field_type === 'string'));
      const answer = result.methods.find(method => method.name === 'Answer');
      assert.ok(answer, 'expected the Answer method');
      assert.equal(answer.signature.return_type, 'i4');
      assert.equal(answer.body.status, 'present');
      assert.match(answer.body.il_sha256, /^[0-9a-f]{64}$/);
      assert.ok(answer.body.instruction_count >= 6);
      assert.ok(answer.body.anchors.some(anchor => anchor.opcode === 'ldc.i4.s' && anchor.operand === '42'));
      const pinvokeMethod = result.methods.find(method => method.name === 'GetProcessId');
      assert.ok(pinvokeMethod);
      assert.equal(pinvokeMethod.impl_flags, 128);
      assert.equal(result.coverage.state, 'complete');
      return {
        fixture: path.basename(assembly),
        target_sha256: managedSha,
        mvid: result.module.mvid,
        type_full_names: result.types.map(type => type.full_name),
        method_il_sha256: answer.body.il_sha256,
        answer_instruction_count: answer.body.instruction_count,
        answer_ldc_value: '42',
        pinvoke_impl_flags: pinvokeMethod.impl_flags
      };
    });

    await h.check('managed-native-boundaries-pinvoke', ['inspect-managed-native-boundaries', assembly, '--format', 'json'], data => {
      assert.equal(data.operation, 'inspect_managed_native_boundaries');
      assert.equal(data.subject.digest.sha256, managedSha);
      const result = data.normalized_result;
      assert.equal(result.summary.pinvoke_import_count, 1);
      assert.equal(result.summary.native_implementation_count, 1);
      assert.equal(result.summary.ready_to_run, false);
      assert.equal(result.summary.mixed_mode_or_native_header, false);
      assert.ok(result.module_refs.some(ref => ref.name === 'kernel32.dll'));
      const pinvoke = result.pinvoke_imports.find(entry => entry.member_name === 'GetProcessId');
      assert.ok(pinvoke, 'expected the GetProcessId P/Invoke import');
      assert.equal(pinvoke.import_name, 'GetCurrentProcessId');
      assert.equal(pinvoke.import_scope_name, 'kernel32.dll');
      assert.equal(pinvoke.verification, 'managed-declaration-only');
      return {
        fixture: path.basename(assembly),
        target_sha256: managedSha,
        mvid: result.module.mvid,
        pinvoke_import_name: pinvoke.import_name,
        pinvoke_scope: pinvoke.import_scope_name,
        pinvoke_verification: pinvoke.verification,
        summary: result.summary
      };
    });
  } else {
    await h.record({
      name: 'managed-fixture-compiler',
      status: 'blocked',
      reason: cscPath
        ? `No managed fixture compiler was found at ${cscPath}.`
        : 'The .NET Framework C# compiler is only available on Windows in this validation module.',
      command: ['inspect-managed-artifact', '<managed assembly>', '--format', 'json']
    });
  }

  const nativeProbeTarget = rustFixture || h.node;

  await probeAvailability(h, {
    name: 'native-binary-layout',
    argv: ['inspect-binary-layout', nativeProbeTarget, '--format', 'json']
  });

  const evmFile = path.join(fixtureDir, 'evm.hex');
  await writeFile(evmFile, EVM_HEX);
  await probeAvailability(h, {
    name: 'evm-interface-offline',
    argv: ['inspect-evm-interface', evmFile, 'hex', '--format', 'json']
  });

  const wasmFile = path.join(fixtureDir, 'minimal.wasm');
  assert(WebAssembly.validate(Buffer.from(MINIMAL_WASM_HEX, 'hex')), 'WASM fixture must be a valid inert module');
  await writeFile(wasmFile, Buffer.from(MINIMAL_WASM_HEX, 'hex'));
  await probeAvailability(h, {
    name: 'wasm-artifact-inspection',
    argv: ['inspect-wasm-artifact', wasmFile, '--format', 'json']
  });

  await ghidraAndFrida(h, fixtureDir);
}

const NATIVE_SOURCE = `int compute_score(int x) {
    int total = x * 3 + 7;
    if (total > 100) { return 100; }
    return total;
}
int main(void) { return compute_score(5); }
`;

async function ghidraAndFrida(h, fixtureDir) {
  const ghidraHome = process.env.GHIDRA_INSTALL_DIR;
  if (!ghidraHome || !(await exists(path.join(ghidraHome, 'support', 'analyzeHeadless')))) {
    await h.record({ name: 'ghidra-native-decompilation', status: 'blocked', reason: 'GHIDRA_INSTALL_DIR is not set to an extracted Ghidra release (support/analyzeHeadless missing); REA does not install or locate Ghidra automatically.' });
  } else {
    const compiler = await findOnPath(['gcc.exe', 'gcc']);
    assert(compiler, 'GHIDRA_INSTALL_DIR is set but no local C compiler exists to build the controlled fixture');
    const source = path.join(fixtureDir, 'ghidra_fixture.c');
    const binary = path.join(fixtureDir, 'ghidra_fixture.exe');
    await writeFile(source, NATIVE_SOURCE);
    const build = await runProcess(compiler, ['-O1', '-o', binary, source], fixtureDir);
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const binarySha = await hashFile(binary);
    await h.check('ghidra-binary-overview', ['inspect', binary, '--provider', 'ghidra', '--format', 'json'], data => {
      assert.equal(data.operation, 'binary_overview');
      assert.equal(data.analysis_profile.parameters.upstream_analysis_profile.provider.id, 'ghidra');
      assert.equal(data.subject.digest.sha256, binarySha);
      const overview = data.normalized_result;
      assert(overview.segments.some(segment => segment.name === '.text' && segment.length > 0));
      assert(overview.procedure_count > 0);
      return { image_base: overview.image_base, procedure_count: overview.procedure_count, segment_count: overview.segment_count, target_sha256: binarySha };
    });
    await h.check('ghidra-decompile-known-logic', ['decompile', binary, '--procedure', 'compute_score', '--provider', 'ghidra', '--format', 'json'], data => {
      assert.equal(data.operation, 'procedure_pseudo_code');
      assert.equal(data.subject.digest.sha256, binarySha);
      // The CLI emits the pseudocode text; JSON object keys preserve each character position.
      const code = typeof data.normalized_result === 'string'
        ? data.normalized_result
        : Object.keys(data.normalized_result).sort((a, b) => Number(a) - Number(b)).map(key => data.normalized_result[key]).join('');
      assert.match(code, /compute_score/);
      assert.match(code, /\*\s*3/);
      assert.match(code, /100/);
      assert.match(code, /return/);
      return { procedure: 'compute_score', pseudocode_excerpt: code.replace(/\s+/g, ' ').trim().slice(0, 200), target_sha256: binarySha, source_logic: 'x*3+7 capped at 100' };
    });
    await h.check('ghidra-search-procedures', ['search', binary, 'compute_score', '--kind', 'procedures', '--provider', 'ghidra', '--format', 'json'], data => {
      assert(Array.isArray(data.normalized_result));
      const hit = data.normalized_result.find(item => item.value === 'compute_score');
      assert(hit, 'expected compute_score in procedure search');
      assert.match(hit.address, /^0x[0-9a-f]+$/);
      return { procedure: hit.value, address: hit.address };
    });
    await h.check('ghidra-xrefs', ['xrefs', binary, 'compute_score', '--provider', 'ghidra', '--format', 'json'], data => {
      assert(Array.isArray(data.normalized_result));
      assert(data.normalized_result.length > 0, 'expected at least one reference to compute_score');
      return { reference_count: data.normalized_result.length, references: data.normalized_result.slice(0, 4) };
    });
  }

  const devices = await h.call(['list-frida-devices', '--format', 'json']);
  if (devices.status !== 0) {
    await h.record({ name: 'frida-device-discovery', status: devices.data?.category === 'unsupported_provider' ? 'blocked' : 'failed', reason: devices.data?.message || devices.stderr, command: devices.command, stdout_file: devices.presentation?.stdout_file, stderr_file: devices.presentation?.stderr_file });
    return;
  }
  await h.checkResult('frida-device-discovery', devices, data => {
    assert(data.devices.some(device => device.deviceId === 'local' && device.type === 'local'));
    return { devices: data.devices.map(device => ({ deviceId: device.deviceId, type: device.type })) };
  });
  const compiler = await findOnPath(['gcc.exe', 'gcc']);
  if (!compiler) {
    await h.record({ name: 'frida-owned-spawn-instrumentation', status: 'not_tested', reason: 'No local C compiler to build the owned Frida fixture.' });
    return;
  }
  const source = path.join(fixtureDir, 'frida_fixture.c');
  const binary = path.join(fixtureDir, 'frida_fixture.exe');
  const script = path.join(fixtureDir, 'frida_probe.js');
  await writeFile(source, 'int main(void) { return 0; }\n');
  const build = await runProcess(compiler, ['-O0', '-o', binary, source], fixtureDir);
  assert.equal(build.status, 0, build.stderr || build.stdout);
  await writeFile(script, 'const module = Process.enumerateModules()[0];\nsend({ marker: "REA_LITE_FRIDA", module_name: module.name, module_size: module.size });\n');
  await h.check('frida-owned-spawn-instrumentation', ['instrument-with-frida', 'spawn', binary, '--script-file', script, '--duration-ms', '800', '--format', 'json'], data => {
    const result = data.evidence.normalized_result;
    assert.equal(data.evidence.operation, 'instrument_with_frida');
    assert.equal(data.cleanup_error, null);
    assert.equal(result.mode, 'spawn');
    assert.equal(result.state, 'detached');
    assert(result.cleanup_error === undefined || result.cleanup_error === null);
    assert(result.pid > 0);
    assert(result.messages.some(message => message.payload?.marker === 'REA_LITE_FRIDA' && message.payload.module_size > 0));
    return { device_id: result.device_id, pid: result.pid, state: result.state, message: result.messages[0]?.payload, owned_fixture: true };
  });

  await idaCheck(h);
}

async function idaCheck(h) {
  const config = process.env.REA_IDA_MCP_CONFIG;
  const target = process.env.REA_LITE_IDA_TARGET;
  const procedure = process.env.REA_LITE_IDA_PROCEDURE;
  if (!config) {
    await h.record({ name: 'ida-attached-decompilation', status: 'blocked', reason: 'REA_IDA_MCP_CONFIG is not set. REA never drives IDA directly: it needs an ida-pro-mcp stdio or loopback HTTP registration.' });
    return;
  }
  if (!target || !procedure) {
    await h.record({ name: 'ida-attached-decompilation', status: 'not_tested', reason: 'IDA attached mode binds the input already open in the GUI by SHA-256. Set REA_LITE_IDA_TARGET to that exact absolute file and REA_LITE_IDA_PROCEDURE to a symbol in it, with the ida-pro-mcp plugin server running.' });
    return;
  }
  const probe = await h.call(['decompile', target, '--procedure', procedure, '--provider', 'ida', '--format', 'json']);
  if (probe.status !== 0) {
    const data = probe.data ?? {};
    await h.record({ name: 'ida-attached-decompilation', status: data.category === 'unsupported_provider' || data.code === 'provider_unavailable' ? 'blocked' : 'failed', reason: data.message || probe.stderr || probe.stdout, command: probe.command, stdout_file: probe.presentation?.stdout_file, stderr_file: probe.presentation?.stderr_file });
    return;
  }
  await h.checkResult('ida-attached-decompilation', probe, data => {
    assert.equal(data.operation, 'procedure_pseudo_code');
    assert.equal(data.provider.id, 'ida');
    const code = typeof data.normalized_result === 'string'
      ? data.normalized_result
      : Object.keys(data.normalized_result).sort((a, b) => Number(a) - Number(b)).map(key => data.normalized_result[key]).join('');
    assert(code.includes(procedure), 'decompiled text must name the requested procedure');
    return { provider: data.provider.id, procedure, pseudocode_excerpt: code.replace(/\s+/g, ' ').trim().slice(0, 200), attached_input: target };
  });
}
