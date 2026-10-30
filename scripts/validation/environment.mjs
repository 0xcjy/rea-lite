import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

export async function validate(h) {
  const firmware = path.join(h.work, 'firmware-gzip.bin');
  await writeFile(firmware, gzipSync(Buffer.from('REA_LITE_FIRMWARE_FIXTURE\n')), { flag: 'wx' });
  const javascript = path.join(h.work, 'recovery-input.js');
  await writeFile(javascript, 'const fixture = { marker: "REA_LITE_RECOVERY" };\n', { flag: 'wx' });
  const probes = [
    ['Android adb client (no device contact)', ['inspect-adb-client', '--format', 'json']],
    ['Android apktool client (no APK decode)', ['inspect-apktool-client', '--format', 'json']],
    ['Packet capture client prerequisites', ['inspect-pcap-client', '--format', 'json']],
    ['Signal decoder prerequisites', ['inspect-signal-decoders', '--limit', '1', '--format', 'json']],
    ['Firmware signature scanner prerequisites', ['inspect-firmware-regions', firmware, '--format', 'json']],
    ['JavaScript source recovery prerequisites', ['recover-javascript-sources', javascript, path.join(h.work, 'recovered-output'), '--format', 'json']]
  ];
  for (const [name, argv] of probes) {
    await h.help(argv[0]);
    const result = await h.call(argv);
    const refs = { command: argv, stdout_file: result.presentation?.stdout_file, stderr_file: result.presentation?.stderr_file, meta_file: result.presentation?.meta_file };
    if (result.status !== 0) {
      const error = result.data;
      const blocked = error?.code === 'capability_unavailable' || error?.code === 'provider_unavailable' || error?.category === 'unsupported_provider';
      await h.record({ name, status: blocked ? 'blocked' : 'failed', ...refs, reason: error?.message || result.stderr || result.stdout, error });
    } else {
      await h.record({ name, status: 'inventory', ...refs, evidence_id: result.data?.evidence_id, reason: 'Prerequisite probe returned successfully; this alone is not semantic proof of a downstream analysis/decoding workflow.', result: result.data?.normalized_result });
    }
  }
  await h.record({ name: 'Live Android / Frida on user process / core-dump workflow', status: 'not_tested', reason: 'Frida was verified only by spawning REA-Lite\'s own compiled fixture. No Android device, user process, or recorded Linux core was selected. No package installation, device mutation, user-process attachment, or Frida injection into a foreign process was attempted.' });
}
