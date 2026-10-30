import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

/*
 * Artifact-family capability validation against the installed REA CLI through the
 * rea-lite wrapper. Every fixture is generated locally from known bytes; every
 * assertion compares a known digest/path/size from those bytes with REA's
 * complete inline Evidence. Nothing here executes a fixture.
 */

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

const CRC_TABLE = new Int32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Minimal deterministic ZIP writer (deflate, UTF-8 names, zero timestamps). */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const whole = Buffer.concat([local, name, compressed]);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));
    locals.push(whole);
    offset += whole.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const macho = text => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(text, 'utf8')]);
const elf = text => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]), Buffer.from(text, 'utf8')]);

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.example.realite</string>
  <key>CFBundleName</key><string>ReaLiteSmoke</string>
  <key>CFBundleExecutable</key><string>ReaLite</string>
  <key>CFBundleShortVersionString</key><string>1.2.3</string>
</dict>
</plist>
`;

function keyedArchiveXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>$archiver</key><string>NSKeyedArchiver</string>
  <key>$version</key><integer>100000</integer>
  <key>$top</key>
  <dict><key>root</key><dict><key>CF$UID</key><integer>1</integer></dict></dict>
  <key>$objects</key>
  <array>
    <string>$null</string>
    <dict>
      <key>marker</key><string>KEYED_ARCHIVE_MARKER</string>
      <key>child</key><dict><key>CF$UID</key><integer>2</integer></dict>
    </dict>
    <string>leaf-value</string>
  </array>
</dict>
</plist>
`;
}

/** Minimal binary plist with one UID reference, matching the XML archive above. */
function keyedArchiveBinary() {
  const string = value => {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length < 15) return Buffer.concat([Buffer.from([0x50 | bytes.length]), bytes]);
    if (bytes.length < 256) return Buffer.concat([Buffer.from([0x5f, 0x10, bytes.length]), bytes]);
    return Buffer.concat([Buffer.from([0x5f, 0x11, bytes.length >> 8, bytes.length & 0xff]), bytes]);
  };
  const integer = value => {
    const bytes = Buffer.alloc(9);
    bytes[0] = 0x13;
    bytes.writeBigUInt64BE(BigInt(value), 1);
    return bytes;
  };
  const dictionary = pairs => Buffer.concat([
    Buffer.from([0xd0 | pairs.length]),
    Buffer.from(pairs.map(([key]) => key)),
    Buffer.from(pairs.map(([, value]) => value))
  ]);
  const array = refs => Buffer.concat([Buffer.from([0xa0 | refs.length]), Buffer.from(refs)]);
  const objects = [
    string('$null'),
    dictionary([[3, 2], [4, 5]]),
    string('KEYED_ARCHIVE_MARKER'),
    string('marker'),
    string('child'),
    string('leaf-value'),
    dictionary([[8, 7], [9, integer(100000)], [10, 12], [11, 14]]),
    string('NSKeyedArchiver'),
    string('$archiver'),
    string('$version'),
    string('$top'),
    string('$objects'),
    dictionary([[13, 1]]),
    string('root'),
    array([0, 1, 5])
  ];
  const header = Buffer.from('bplist00', 'latin1');
  const body = Buffer.concat(objects);
  const offsets = [];
  let at = 0;
  for (const object of objects) {
    offsets.push(at + header.length);
    at += object.length;
  }
  const offsetTable = Buffer.alloc(offsets.length * 4);
  offsets.forEach((value, index) => offsetTable.writeUInt32BE(value, index * 4));
  const trailer = Buffer.alloc(32);
  trailer[6] = 4;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(6n, 16);
  trailer.writeBigUInt64BE(BigInt(header.length + body.length), 24);
  return Buffer.concat([header, body, offsetTable, trailer]);
}

function buildHar(firstBody, secondBody) {
  const entry = (method, url, status, body, encoding, query) => ({
    startedDateTime: '2026-01-02T03:04:05.000Z',
    time: 5,
    request: {
      method, url, httpVersion: 'HTTP/1.1', headers: [], queryString: query ?? [], cookies: [], headersSize: -1, bodySize: 0
    },
    response: {
      status,
      statusText: 'fixture',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'content-type', value: 'text/plain' }],
      cookies: [],
      content: {
        size: Buffer.byteLength(body),
        mimeType: 'text/plain',
        text: encoding ? Buffer.from(body).toString('base64') : body,
        ...(encoding ? { encoding } : {})
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: Buffer.byteLength(body)
    },
    cache: {},
    timings: { send: 1, wait: 1, receive: 1 }
  });
  return Buffer.from(JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'rea-lite-validation', version: '1' },
      entries: [
        entry('GET', 'https://example.invalid/api/known/42?q=abc', 201, firstBody, 'base64', [{ name: 'q', value: 'abc' }]),
        entry('POST', 'https://example.invalid/api/known/7', 418, secondBody)
      ]
    }
  }), 'utf8');
}

function inventoryOf(evidence) {
  assert.equal(evidence.operation, 'inspect_artifact');
  const substeps = evidence.normalized_result?.substeps;
  assert.ok(Array.isArray(substeps) && substeps.length === 1, 'expected exactly one inventory substep');
  const inventory = substeps[0].evidence;
  assert.equal(inventory.operation, 'inventory_artifact');
  return inventory;
}

function occurrencesByPath(inventory) {
  return new Map(inventory.normalized_result.occurrences.map(occurrence => [occurrence.logical_path, occurrence]));
}

function nodesById(inventory) {
  return new Map(inventory.normalized_result.nodes.map(node => [node.artifact_id, node]));
}

/** Verify one package inventory against locally known entry bytes. */
function verifyInventory(label, evidence, fileBytes, entries, expectedFormats) {
  assert.equal(evidence.subject.digest.sha256, sha256(fileBytes));
  const inventory = inventoryOf(evidence);
  const result = inventory.normalized_result;
  assert.equal(result.manifest.root_sha256, sha256(fileBytes));
  assert.equal(result.manifest.node_count, entries.length + 1);
  assert.equal(result.manifest.occurrence_count, entries.length + 1);
  assert.equal(result.manifest.edge_count, entries.length);
  assert.equal(result.coverage.scope, 'container-entries');
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage_status, 'complete');
  assert.equal(result.integrity_contradictions.length, 0);
  const occurrences = occurrencesByPath(inventory);
  const nodes = nodesById(inventory);
  assert.equal(occurrences.size, entries.length + 1);
  const root = occurrences.get('.');
  assert.equal(root.artifact_kind, 'container');
  assert.equal(root.artifact_format, result.manifest.root_format);
  const observed = {};
  for (const entry of entries) {
    const occurrence = occurrences.get(entry.name);
    assert.ok(occurrence, `${label}: missing occurrence ${entry.name}`);
    assert.equal(occurrence.entry_kind, 'file');
    assert.equal(occurrence.hash_status, 'verified');
    assert.equal(occurrence.declared_size, entry.data.length);
    const node = nodes.get(occurrence.artifact_id);
    assert.ok(node, `${label}: missing node ${entry.name}`);
    assert.equal(node.sha256, sha256(entry.data));
    assert.equal(node.size, entry.data.length);
    if (expectedFormats?.[entry.name]) assert.equal(occurrence.artifact_format, expectedFormats[entry.name]);
    observed[entry.name] = {
      occurrence_id: occurrence.occurrence_id,
      artifact_id: occurrence.artifact_id,
      sha256: node.sha256,
      artifact_format: occurrence.artifact_format
    };
  }
  return { inventory, result, observed, inventoryEvidenceId: inventory.evidence_id };
}

async function recordUnsupported(h, name, argv, workflow) {
  const result = await h.call(argv);
  const refs = {
    command: argv,
    stdout_file: result.presentation?.stdout_file,
    stderr_file: result.presentation?.stderr_file,
    meta_file: result.presentation?.meta_file,
    exit_code: result.status
  };
  const error = result.data && typeof result.data === 'object' ? result.data : {};
  const reason = [error.code, error.message, error.details?.reason].filter(Boolean).join(' — ');
  if (result.status === 0) {
    await h.record({ name, status: 'inventory', reason: `${workflow}: provider returned successfully; prerequisite readiness alone is not semantic validation of this workflow`, evidence_id: result.data?.evidence_id, ...refs });
    return result;
  }
  const unsupported = error.code === 'capability_unavailable' || error.category === 'unsupported_provider';
  await h.record({
    name,
    status: unsupported ? 'blocked' : 'failed',
    reason: reason || `exit ${result.status}: ${result.stderr || result.stdout}`,
    workflow,
    provider: error.details?.provider_id ?? null,
    code: error.code ?? null,
    category: error.category ?? null,
    ...refs
  });
  return result;
}

export async function validate(h) {
  const work = h.work;
  const facts = {};

  // ---------------------------------------------------------------------------
  // 1. ZIP artifact inventory with known entries and digests.
  // ---------------------------------------------------------------------------
  const zipEntries = [
    { name: 'app/main.js', data: Buffer.from('module.exports = { marker: "ARTIFACT_ZIP" };\n') },
    { name: 'app/config.json', data: Buffer.from('{"setting":"enabled","count":3}\n') },
    { name: 'app/nested/readme.txt', data: Buffer.from('nested payload é 😀\n', 'utf8') },
    { name: 'app/dir with space/note.txt', data: Buffer.from('space-path entry\n', 'utf8') },
    { name: 'app/资源/说明.txt', data: Buffer.from('unicode-path entry\n', 'utf8') }
  ];
  const zipBytes = buildZip(zipEntries);
  const zipPath = path.join(work, 'artifact-fixture.zip');
  await writeFile(zipPath, zipBytes);
  const zipInspect = await h.check('artifact/inspect-zip-inventory', ['inspect-artifact', zipPath, '--format', 'json'], data => {
    assert.equal(data.operation, 'inspect_artifact');
    assert.equal(data.subject.format, 'zip');
    const verified = verifyInventory('zip', data, zipBytes, zipEntries, { 'app/main.js': 'javascript-bundle' });
    assert.equal(verified.result.manifest.root_format, 'zip');
    facts.zip = verified.observed;
    return {
      inventory_evidence_id: verified.inventoryEvidenceId,
      manifest: verified.result.manifest,
      coverage: verified.result.coverage,
      entries: verified.observed,
      limitations: verified.result.limitations
    };
  });

  const zipViewInput = await h.input('artifacts-zip-inventory-view', {
    source: { kind: 'inline', evidence: zipInspect.data },
    view: { kind: 'inventory', collection: 'occurrences', logical_paths: ['app/main.js', 'app/资源/说明.txt'] }
  });
  await h.check('artifact/inventory-analysis-view', ['inspect-analysis-view', zipViewInput, '--format', 'json'], data => {
    assert.equal(data.operation, 'inspect_analysis_view');
    const view = data.normalized_result;
    assert.equal(view.kind, 'inventory');
    assert.equal(view.parent_operation, 'inspect_artifact');
    assert.equal(view.parent_evidence_id, zipInspect.data.evidence_id);
    assert.equal(view.source_complete, true);
    assert.deepEqual(view.items.map(item => item.logical_path).sort(), ['app/main.js', 'app/资源/说明.txt']);
    for (const item of view.items) {
      assert.equal(item.hash_status, 'verified');
      assert.equal(item.artifact_id, facts.zip[item.logical_path].artifact_id);
    }
    assert.equal(view.coverage.status, 'page');
    assert.equal(view.coverage.exhausted, true);
    return {
      parent_evidence_id: view.parent_evidence_id,
      parent_digest: view.parent_digest,
      items: view.items.map(item => item.logical_path),
      artifact_ids: view.items.map(item => item.artifact_id),
      coverage: view.coverage
    };
  });

  // ---------------------------------------------------------------------------
  // 2. Safe extraction: exact bytes materialized, traversal refused.
  // ---------------------------------------------------------------------------
  await h.check('artifact/extract-zip', ['extract-artifact', zipPath, '--format', 'json'], async data => {
    assert.equal(data.operation, 'extract_artifact');
    const result = data.normalized_result;
    assert.equal(result.containment_verified, true);
    assert.equal(result.integrity_contradictions.length, 0);
    assert.equal(result.artifacts.length, zipEntries.length);
    assert.equal(result.manifest.root_sha256, sha256(zipBytes));
    const outputRoot = result.output_root;
    assert.equal((await stat(outputRoot)).isDirectory(), true);
    const observed = {};
    for (const artifact of result.artifacts) {
      const fixture = zipEntries.find(entry => entry.name === artifact.relative_path);
      assert.ok(fixture, `unexpected extracted path ${artifact.relative_path}`);
      assert.equal(artifact.created, true);
      assert.equal(artifact.sha256, sha256(fixture.data));
      assert.equal(artifact.bytes_written, fixture.data.length);
      assert.deepEqual(await readFile(path.join(outputRoot, artifact.relative_path)), fixture.data);
      observed[artifact.relative_path] = { sha256: artifact.sha256, bytes_written: artifact.bytes_written };
    }
    assert.equal(Object.keys(observed).length, zipEntries.length);
    return {
      output_root: outputRoot,
      extraction_id: result.extraction_manifest.extraction_id,
      files_sha256: result.extraction_manifest.files_sha256,
      containment_verified: result.containment_verified,
      files: observed,
      cleanup: result.cleanup
    };
  });

  const canary = `rea-lite-traversal-${process.pid}-${Date.now()}.txt`;
  const traversalPath = path.join(work, 'artifact-traversal.zip');
  await writeFile(traversalPath, buildZip([
    { name: 'safe.txt', data: Buffer.from('safe-entry') },
    { name: `../${canary}`, data: Buffer.from('ESCAPED') }
  ]));
  const traversalArgv = ['extract-artifact', traversalPath, '--format', 'json'];
  const traversal = await h.call(traversalArgv);
  const traversalRefs = {
    command: traversalArgv,
    stdout_file: traversal.presentation?.stdout_file,
    stderr_file: traversal.presentation?.stderr_file,
    meta_file: traversal.presentation?.meta_file
  };
  try {
    assert.notEqual(traversal.status, 0, 'traversal archive must be refused');
    assert.equal(traversal.data?.code, 'artifact_operation_failed');
    assert.equal(traversal.data?.details?.operation, 'extract_artifact');
    for (const escaped of [path.join(os.tmpdir(), canary), path.join(work, canary), path.resolve(os.tmpdir(), '..', canary)]) {
      assert.equal(existsSync(escaped), false, `traversal wrote ${escaped}`);
    }
    await h.record({
      name: 'artifact/extract-rejects-traversal',
      status: 'passed',
      ...traversalRefs,
      facts: { canary, exit_code: traversal.status, code: traversal.data.code, message: traversal.data.message, escaped_bytes_written: false }
    });
  } catch (error) {
    await h.record({ name: 'artifact/extract-rejects-traversal', status: 'failed', reason: error.message, ...traversalRefs });
  }

  // ---------------------------------------------------------------------------
  // 3. Retained HAR capture: known URL/status/body, then the API-surface view.
  // ---------------------------------------------------------------------------
  const harFirstBody = 'REA_HAR_BODY';
  const harSecondBody = 'HAR_SECOND_BODY';
  const harBytes = buildHar(harFirstBody, harSecondBody);
  const harPath = path.join(work, 'artifact-capture.har');
  await writeFile(harPath, harBytes);
  const harInspect = await h.check('artifact/har-inventory', ['inspect-web-network-capture', harPath, 'har', '--format', 'json'], data => {
    assert.equal(data.operation, 'inspect_web_network_capture');
    assert.equal(data.provider.id, 'har-schema/lossless-json');
    assert.equal(data.confidence, 'observed');
    assert.equal(data.authority, 'historical-reference');
    assert.equal(data.subject.digest.sha256, sha256(harBytes));
    const result = data.normalized_result;
    assert.equal(result.total_records, 2);
    assert.equal(result.records.length, 2);
    const [first, second] = result.records;
    assert.equal(first.ordinal, 0);
    assert.equal(first.reported.request.method, 'GET');
    assert.equal(first.reported.request.url, 'https://example.invalid/api/known/42?q=abc');
    assert.equal(first.reported.response.status, 201);
    assert.equal(first.binary_fields.length, 1);
    assert.equal(first.binary_fields[0].pointer, '/response/content/text');
    assert.equal(first.binary_fields[0].representation, 'har-base64-content');
    assert.equal(first.binary_fields[0].state, 'retained');
    assert.equal(first.binary_fields[0].bytes, Buffer.byteLength(harFirstBody));
    assert.equal(first.binary_fields[0].sha256, sha256(harFirstBody));
    assert.deepEqual(Buffer.from(first.binary_fields[0].content_base64, 'base64'), Buffer.from(harFirstBody));
    assert.equal(second.ordinal, 1);
    assert.equal(second.reported.request.method, 'POST');
    assert.equal(second.reported.request.url, 'https://example.invalid/api/known/7');
    assert.equal(second.reported.response.status, 418);
    assert.equal(second.reported.response.content.text, harSecondBody);
    assert.equal(second.binary_fields.length, 0);
    return {
      total_records: result.total_records,
      urls: [first.reported.request.url, second.reported.request.url],
      statuses: [first.reported.response.status, second.reported.response.status],
      first_body_sha256: first.binary_fields[0].sha256,
      second_body_text: second.reported.response.content.text,
      decoder: result.decoder,
      limitations: result.limitations
    };
  });

  const harViewInput = await h.input('artifacts-har-api-surface', {
    source: { kind: 'inline', evidence: harInspect.data },
    view: { kind: 'api-surface' }
  });
  await h.check('artifact/har-api-surface-view', ['inspect-analysis-view', harViewInput, '--format', 'json'], data => {
    assert.equal(data.operation, 'inspect_analysis_view');
    const view = data.normalized_result;
    assert.equal(view.kind, 'api-surface');
    assert.equal(view.parent_operation, 'inspect_web_network_capture');
    assert.equal(view.parent_evidence_id, harInspect.data.evidence_id);
    assert.equal(view.templated_groups, 2);
    assert.equal(view.coverage.exhausted, true);
    assert.deepEqual(view.records, { examined: 2, total: 2, excluded: 0 });
    const get = view.groups.find(group => group.method === 'GET');
    const post = view.groups.find(group => group.method === 'POST');
    assert.ok(get && post, 'expected one GET and one POST group');
    assert.equal(get.origin, 'https://example.invalid');
    assert.equal(get.path_template, '/api/known/{numeric}');
    assert.deepEqual(get.record_ordinals, [0]);
    assert.deepEqual(get.statuses, [201]);
    assert.equal(post.path_template, '/api/known/{numeric}');
    assert.deepEqual(post.record_ordinals, [1]);
    assert.deepEqual(post.statuses, [418]);
    return {
      parent_evidence_id: view.parent_evidence_id,
      groups: view.groups.map(group => ({ method: group.method, path_template: group.path_template, record_ordinals: group.record_ordinals, statuses: group.statuses })),
      coverage: view.coverage,
      records: view.records
    };
  });

  // ---------------------------------------------------------------------------
  // 4. Foundation keyed archives: XML plist and binary plist (UID references).
  // ---------------------------------------------------------------------------
  const xmlArchive = Buffer.from(keyedArchiveXml(), 'utf8');
  const xmlArchivePath = path.join(work, 'artifact-archive-xml.plist');
  await writeFile(xmlArchivePath, xmlArchive);
  await h.check('artifact/keyed-archive-xml', ['inspect-keyed-archive', xmlArchivePath, '--format', 'json'], data => {
    assert.equal(data.operation, 'inspect_keyed_archive');
    const result = data.normalized_result;
    assert.equal(result.archive_format, 'xml-plist');
    assert.equal(result.archive_sha256, sha256(xmlArchive));
    assert.equal(result.target_sha256, sha256(xmlArchive));
    assert.equal(result.roots.root['CF$UID'], 1);
    assert.equal(result.total_objects, 3);
    assert.equal(result.total_references, 2);
    assert.equal(result.objects.length, 3);
    assert.equal(result.objects[0].kind, 'nil');
    assert.equal(result.objects[1].kind, 'dictionary');
    assert.equal(result.objects[1].value.marker, 'KEYED_ARCHIVE_MARKER');
    assert.equal(result.objects[1].value.child['CF$UID'], 2);
    assert.deepEqual(result.references.map(reference => reference.status), ['resolved', 'resolved']);
    assert.equal(result.truncated, false);
    return {
      archive_format: result.archive_format,
      archive_sha256: result.archive_sha256,
      roots: result.roots,
      total_objects: result.total_objects,
      total_references: result.total_references,
      references: result.references
    };
  });

  const binaryArchive = keyedArchiveBinary();
  const binaryArchivePath = path.join(work, 'artifact-archive-binary.plist');
  await writeFile(binaryArchivePath, binaryArchive);
  await h.check('artifact/keyed-archive-binary', ['inspect-keyed-archive', binaryArchivePath, '--format', 'json'], data => {
    assert.equal(data.operation, 'inspect_keyed_archive');
    const result = data.normalized_result;
    assert.equal(result.archive_format, 'binary-plist');
    assert.equal(result.archive_sha256, sha256(binaryArchive));
    assert.equal(result.total_objects, 3);
    assert.equal(result.objects[1].kind, 'dictionary');
    assert.equal(result.objects[2].value, 'leaf-value');
    assert.equal(result.roots.root.marker, 'KEYED_ARCHIVE_MARKER');
    assert.equal(result.roots.root.child, 'leaf-value');
    assert.equal(result.truncated, false);
    return {
      archive_format: result.archive_format,
      archive_sha256: result.archive_sha256,
      roots: result.roots,
      total_objects: result.total_objects,
      objects: result.objects
    };
  });

  // ---------------------------------------------------------------------------
  // 5. Apple application graph from inline IPA inventory Evidence.
  // ---------------------------------------------------------------------------
  const appleEntries = [
    { name: 'Payload/ReaLite.app/Info.plist', data: Buffer.from(INFO_PLIST, 'utf8') },
    { name: 'Payload/ReaLite.app/ReaLite', data: macho('rea-lite-ipa-binary') },
    { name: 'Payload/ReaLite.app/Frameworks/libswiftCore.dylib', data: macho('swift-core') },
    { name: 'Payload/ReaLite.app/en.lproj/Localizable.strings', data: Buffer.from('"hello" = "world";\n', 'utf8') }
  ];
  const ipaBytes = buildZip(appleEntries);
  const ipaPath = path.join(work, 'artifact-ReaLite.ipa');
  await writeFile(ipaPath, ipaBytes);
  const ipaInspect = await h.check('artifact/apple-ipa-inventory', ['inspect-artifact', ipaPath, '--format', 'json'], data => {
    assert.equal(data.subject.format, 'ipa');
    const verified = verifyInventory('ipa', data, ipaBytes, appleEntries, {
      'Payload/ReaLite.app/Info.plist': 'plist',
      'Payload/ReaLite.app/ReaLite': 'mach-o',
      'Payload/ReaLite.app/Frameworks/libswiftCore.dylib': 'mach-o'
    });
    assert.equal(verified.result.manifest.root_format, 'ipa');
    facts.apple = verified.observed;
    return {
      inventory_evidence_id: verified.inventoryEvidenceId,
      manifest: verified.result.manifest,
      occurrences: verified.observed,
      coverage: verified.result.coverage,
      fixture_kind: 'synthetic IPA ZIP; the Mach-O members carry only a header magic, not a loadable image'
    };
  });
  const appleInput = await h.input('artifacts-apple-projection', { inventory_evidence: [ipaInspect.data] });
  await h.check('artifact/apple-application-graph', ['project-apple-application-graph', appleInput, '--format', 'json'], data => {
    assert.equal(data.operation, 'project_apple_application_graph');
    const result = data.normalized_result;
    assert.match(result.projection_id, /^aap_/);
    assert.equal(result.root_sha256, sha256(ipaBytes));
    assert.equal(result.root_format, 'ipa');
    assert.deepEqual(result.platforms, ['ios']);
    assert.deepEqual(result.source_evidence_ids, [ipaInspect.data.evidence_id]);
    assert.deepEqual(result.application_roots, ['Payload/ReaLite.app']);
    assert.equal(result.bundles.length, 1);
    assert.equal(result.bundles[0].path, 'Payload/ReaLite.app');
    assert.equal(result.bundles[0].role, 'application');
    assert.equal(result.bundles[0].role_basis, 'path-convention');
    assert.equal(result.bundles[0].info_plist_path, 'Payload/ReaLite.app/Info.plist');
    assert.equal(result.components.bundle_metadata.length, 1);
    assert.equal(result.components.bundle_metadata[0].sha256, facts.apple['Payload/ReaLite.app/Info.plist'].sha256);
    assert.equal(result.components.executables.length, 2);
    const executable = result.components.executables.find(component => component.path === 'Payload/ReaLite.app/ReaLite');
    assert.ok(executable);
    assert.equal(executable.format, 'mach-o');
    assert.equal(executable.sha256, facts.apple['Payload/ReaLite.app/ReaLite'].sha256);
    assert.deepEqual(result.runtime_families, ['native', 'swift-objective-c']);
    assert.equal(result.coverage.status, 'complete-within-inventory');
    assert.equal(result.coverage.inventory_complete, true);
    return {
      projection_id: result.projection_id,
      root_format: result.root_format,
      application_roots: result.application_roots,
      bundles: result.bundles,
      components: result.components,
      runtime_families: result.runtime_families,
      source_evidence_ids: result.source_evidence_ids,
      coverage: result.coverage
    };
  });

  // ---------------------------------------------------------------------------
  // 6. Android application graph from inline APK inventory Evidence.
  //    The fixture is a synthetic ZIP named .apk; it is not installable.
  // ---------------------------------------------------------------------------
  const androidEntries = [
    { name: 'AndroidManifest.xml', data: Buffer.from('<?xml version="1.0" encoding="utf-8"?><manifest package="com.example.realite"><application android:label="ReaLite"/></manifest>', 'utf8') },
    { name: 'classes.dex', data: Buffer.concat([Buffer.from('dex\n035\0', 'latin1'), Buffer.alloc(104)]) },
    { name: 'lib/arm64-v8a/libnative.so', data: elf('android-native-library') },
    { name: 'assets/index.android.bundle', data: Buffer.from('var marker = "ANDROID_APK_BUNDLE";\n', 'utf8') },
    { name: 'res/layout/activity_main.xml', data: Buffer.from('<LinearLayout/>', 'utf8') }
  ];
  const apkBytes = buildZip(androidEntries);
  const apkPath = path.join(work, 'artifact-ReaLite.apk');
  await writeFile(apkPath, apkBytes);
  const apkInspect = await h.check('artifact/android-apk-inventory', ['inspect-artifact', apkPath, '--format', 'json'], data => {
    assert.equal(data.subject.format, 'apk');
    const verified = verifyInventory('apk', data, apkBytes, androidEntries, { 'lib/arm64-v8a/libnative.so': 'elf' });
    assert.equal(verified.result.manifest.root_format, 'apk');
    facts.android = verified.observed;
    return {
      inventory_evidence_id: verified.inventoryEvidenceId,
      manifest: verified.result.manifest,
      occurrences: verified.observed,
      coverage: verified.result.coverage,
      fixture_kind: 'synthetic ZIP named .apk; not installable; AndroidManifest.xml is not binary AXML'
    };
  });
  const androidInput = await h.input('artifacts-android-projection', { inventory_evidence: [apkInspect.data] });
  await h.check('artifact/android-application-graph', ['project-android-application-graph', androidInput, '--format', 'json'], data => {
    assert.equal(data.operation, 'project_android_application_graph');
    const result = data.normalized_result;
    assert.equal(result.root_sha256, sha256(apkBytes));
    assert.equal(result.root_format, 'apk');
    assert.deepEqual(result.source_evidence_ids, [apkInspect.data.evidence_id]);
    assert.equal(result.components.manifests.length, 1);
    assert.equal(result.components.manifests[0].path, 'AndroidManifest.xml');
    assert.equal(result.components.manifests[0].sha256, facts.android['AndroidManifest.xml'].sha256);
    assert.equal(result.components.dex.length, 1);
    assert.equal(result.components.dex[0].path, 'classes.dex');
    assert.equal(result.components.dex[0].sha256, facts.android['classes.dex'].sha256);
    assert.equal(result.components.native_libraries.length, 1);
    assert.equal(result.components.native_libraries[0].path, 'lib/arm64-v8a/libnative.so');
    assert.equal(result.components.native_libraries[0].format, 'elf');
    assert.deepEqual(result.runtime_families, ['dalvik-art', 'native']);
    assert.deepEqual(result.bridge_candidates, [{
      managed_path: 'classes.dex',
      native_path: 'lib/arm64-v8a/libnative.so',
      basis: 'jni-library-convention'
    }]);
    assert.equal(result.coverage.status, 'complete-within-inventory');
    assert.equal(result.coverage.inventory_complete, true);
    return {
      projection_id: result.projection_id,
      root_format: result.root_format,
      components: result.components,
      runtime_families: result.runtime_families,
      bridge_candidates: result.bridge_candidates,
      source_evidence_ids: result.source_evidence_ids,
      coverage: result.coverage,
      limitation: 'projection reports exact inventory paths and hashes; manifest/DEX semantics need a dedicated Android provider'
    };
  });

  // ---------------------------------------------------------------------------
  // 7. HarmonyOS application graph from inline HAP inventory Evidence.
  //    The fixture is a synthetic ZIP named .hap; it is not a signed HAP.
  // ---------------------------------------------------------------------------
  const harmonyEntries = [
    { name: 'module.json', data: Buffer.from(JSON.stringify({ module: { name: 'entry', type: 'entry', versionCode: 1000 } }), 'utf8') },
    { name: 'ets/modules.abc', data: Buffer.from('PANDA ark-bytecode-fixture', 'utf8') },
    { name: 'libs/arm64-v8a/libentry.so', data: elf('harmony-native-library') },
    { name: 'resources.index', data: Buffer.from('resources-index-fixture', 'utf8') },
    { name: 'META-INF/CERT.RSA', data: Buffer.from('certificate-fixture', 'utf8') }
  ];
  const hapBytes = buildZip(harmonyEntries);
  const hapPath = path.join(work, 'artifact-ReaLite.hap');
  await writeFile(hapPath, hapBytes);
  const hapInspect = await h.check('artifact/harmony-hap-inventory', ['inspect-artifact', hapPath, '--format', 'json'], data => {
    assert.equal(data.subject.format, 'hap');
    const verified = verifyInventory('hap', data, hapBytes, harmonyEntries, { 'libs/arm64-v8a/libentry.so': 'elf' });
    assert.equal(verified.result.manifest.root_format, 'hap');
    facts.harmony = verified.observed;
    return {
      inventory_evidence_id: verified.inventoryEvidenceId,
      manifest: verified.result.manifest,
      occurrences: verified.observed,
      coverage: verified.result.coverage,
      fixture_kind: 'synthetic ZIP named .hap; not a signed HarmonyOS package'
    };
  });
  const harmonyInput = await h.input('artifacts-harmony-projection', { inventory_evidence: [hapInspect.data] });
  await h.check('artifact/harmony-application-graph', ['project-harmony-application-graph', harmonyInput, '--format', 'json'], data => {
    assert.equal(data.operation, 'project_harmony_application_graph');
    const result = data.normalized_result;
    assert.equal(result.root_sha256, sha256(hapBytes));
    assert.equal(result.root_format, 'hap');
    assert.equal(result.packaging_model, 'stage');
    assert.deepEqual(result.source_evidence_ids, [hapInspect.data.evidence_id]);
    assert.equal(result.components.manifests.length, 1);
    assert.equal(result.components.manifests[0].path, 'module.json');
    assert.equal(result.components.manifests[0].sha256, facts.harmony['module.json'].sha256);
    assert.equal(result.components.bytecode.length, 1);
    assert.equal(result.components.bytecode[0].path, 'ets/modules.abc');
    assert.equal(result.components.resources.length, 1);
    assert.equal(result.components.resources[0].path, 'resources.index');
    assert.equal(result.components.native_libraries.length, 1);
    assert.equal(result.components.native_libraries[0].format, 'elf');
    assert.deepEqual(result.runtime_families, ['ark', 'native']);
    assert.deepEqual(result.bridge_candidates, [{
      managed_path: 'ets/modules.abc',
      native_path: 'libs/arm64-v8a/libentry.so',
      basis: 'napi-library-convention'
    }]);
    assert.deepEqual(result.app_pack_children, []);
    assert.equal(result.coverage.status, 'complete-within-inventory');
    assert.equal(result.coverage.inventory_complete, true);
    return {
      projection_id: result.projection_id,
      root_format: result.root_format,
      packaging_model: result.packaging_model,
      components: result.components,
      runtime_families: result.runtime_families,
      bridge_candidates: result.bridge_candidates,
      source_evidence_ids: result.source_evidence_ids,
      coverage: result.coverage,
      limitation: 'projection reports exact inventory paths and hashes; manifest/module semantics need a dedicated HarmonyOS provider'
    };
  });

  // ---------------------------------------------------------------------------
  // 8. Observed provider blockers on this host (recorded, not workarounds).
  // ---------------------------------------------------------------------------
  await recordUnsupported(
    h,
    'artifact/plist-inspection-provider',
    ['inspect-plist', path.join(work, 'artifact-ReaLite.ipa'), '--relative-path', 'Payload/ReaLite.app/Info.plist', '--format', 'json'],
    'Apple Info.plist parsing (inspect-plist) depends on native macOS utilities. Foundation keyed-archive parsing itself is covered above.'
  );
  await recordUnsupported(
    h,
    'artifact/android-package-provider',
    ['inspect-android-package', apkPath, '--format', 'json'],
    'Android package/manifest/DEX inspection (inspect-android-package) needs REA_JADX_MCP_JAR. The inline inventory projection above does not parse Android semantics.'
  );
  await recordUnsupported(
    h,
    'artifact/android-resource-provider',
    ['decode-android-resources', apkPath, '--format', 'json'],
    'APK resource decoding (decode-android-resources) needs an apktool launcher (REA_APKTOOL_COMMAND or PATH).'
  );
}
