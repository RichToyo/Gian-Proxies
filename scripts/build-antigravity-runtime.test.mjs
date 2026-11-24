import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, lstat, mkdir, open, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  antigravityRuntimeSource,
  buildAntigravityRuntimeCandidate,
  extractAntigravityCli,
  packAntigravityCli,
  readAntigravityCliBinary,
} from './build-antigravity-runtime.mjs';

const BLOCK = 512;

/** Synthetic single-header tar.gz; never official bytes. */
function tarGz(members, { magic = 'ustar  \0', corruptChecksum = false, trailingBlocks = 2 } = {}) {
  const blocks = [];
  for (const member of members) {
    const data = member.data ?? Buffer.from('cli-bytes');
    const header = Buffer.alloc(BLOCK);
    header.write(member.name, 0, 100, 'utf8');
    header.write('0000755\0', 100, 8, 'latin1');
    header.write('0000000\0', 108, 8, 'latin1');
    header.write('0000000\0', 116, 8, 'latin1');
    header.write(`${(member.size ?? data.length).toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
    header.write('00000000000\0', 136, 12, 'latin1');
    header.write(member.type ?? '0', 156, 1, 'latin1');
    header.write(magic, 257, 8, 'latin1');
    header.write(member.prefix ?? '', 345, 155, 'utf8');
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    if (corruptChecksum) sum += 1;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
    blocks.push(header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  blocks.push(Buffer.alloc(BLOCK * trailingBlocks));
  return gzipSync(Buffer.concat(blocks));
}

function recipeFor(data, sourceMember = 'antigravity') {
  return {
    ...antigravityRuntimeSource,
    sourceMember,
    binarySize: data.length,
    binarySha256: createHash('sha256').update(data).digest('hex'),
  };
}

test('the Antigravity source recipe pins Google\'s darwin-arm64 agy 1.5.16 archive', () => {
  assert.equal(antigravityRuntimeSource.schemaVersion, 1);
  assert.equal(antigravityRuntimeSource.kind, 'antigravity-cli');
  assert.equal(antigravityRuntimeSource.provider, 'antigravity');
  assert.equal(antigravityRuntimeSource.pluginId, 'io.gian.antigravity');
  assert.equal(antigravityRuntimeSource.runtimeId, 'antigravity-acp');
  assert.equal(antigravityRuntimeSource.version, '1.5.16');
  assert.equal(antigravityRuntimeSource.platform, 'darwin-arm64');
  assert.equal(antigravityRuntimeSource.upstreamPlatform, 'darwin_arm64');
  assert.equal(antigravityRuntimeSource.format, 'tar.gz');
  assert.equal(antigravityRuntimeSource.entryRelativePath, 'agy');
  assert.equal(antigravityRuntimeSource.entryMode, 0o755);
  assert.equal(antigravityRuntimeSource.sourceUrl,
    'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/darwin-arm/cli_mac_arm64.tar.gz');
  assert.equal(antigravityRuntimeSource.sourceSha256,
    'ba47202f712de4c4a78fd787d81ba206d73e11c97572fc69420f29a77efc8d95');
  assert.match(antigravityRuntimeSource.sourceSha512, /^33f5617dc74fea60[a-f0-9]{112}$/);
  assert.equal(antigravityRuntimeSource.sourceSize, 86506312);
  assert.equal(antigravityRuntimeSource.sourceMember, 'antigravity');
  assert.equal(antigravityRuntimeSource.binarySha256,
    'b746bd68eb150f594e53af1e5577c8b101eaf33bd44ca10ac683af90e0630cf3');
  assert.equal(antigravityRuntimeSource.binarySize, 230641440);
  assert.equal(Object.hasOwn(antigravityRuntimeSource, 'publish'), false);
});

test('extraction writes only the pinned binary, as agy, executable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = Buffer.from('agy-binary-bytes');
  const destination = join(root, 'out');
  const entry = await extractAntigravityCli(tarGz([{ name: 'antigravity', data }]), destination, recipeFor(data));
  assert.equal(entry, join(destination, 'agy'));
  assert.deepEqual(await readdir(destination), ['agy']);
  assert.deepEqual(await readFile(entry), data);
  assert.equal((await lstat(entry)).mode & 0o777, 0o755);
  // POSIX "ustar\000" headers are accepted too.
  assert.deepEqual(readAntigravityCliBinary(tarGz([{ name: 'antigravity', data }], { magic: 'ustar\u000000' }), recipeFor(data)), data);
});

test('extraction rejects other names, links, extra members, size or digest drift and corrupt headers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-cli-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = Buffer.from('agy-binary-bytes');
  const recipe = recipeFor(data);
  const read = bytes => () => readAntigravityCliBinary(bytes, recipe);
  for (const name of ['../antigravity', '/antigravity', 'nested/antigravity', 'agy', 'antigravity.exe']) {
    assert.throws(read(tarGz([{ name, data }])), /unexpected member/, name);
  }
  assert.throws(read(tarGz([{ name: 'antigravity', data, prefix: 'nested' }])), /unexpected member/);
  assert.throws(read(tarGz([{ name: 'antigravity', data, type: '2' }])), /not a regular file/);
  assert.throws(read(tarGz([{ name: 'antigravity', data, type: '5' }])), /not a regular file/);
  assert.throws(read(tarGz([{ name: 'antigravity', data }, { name: 'extra', data: Buffer.from('x') }])),
    /more than one member/);
  assert.throws(read(tarGz([{ name: 'antigravity', data: Buffer.from('agy-binary-bytez') }])), /pinned digest/);
  assert.throws(read(tarGz([{ name: 'antigravity', data: Buffer.from('short') }])), /member size/);
  assert.throws(read(tarGz([{ name: 'antigravity', data }], { corruptChecksum: true })), /header checksum/);
  assert.throws(read(tarGz([{ name: 'antigravity', data }], { magic: 'notustar' })), /not ustar/);
  assert.throws(read(tarGz([{ name: 'antigravity', data }], { trailingBlocks: 0 })), /tar length|truncated/);
  assert.throws(read(Buffer.from('not gzip')), /gzip/);
  // The output directory must be a real directory.
  const file = join(root, 'file');
  await writeFile(file, 'x');
  await assert.rejects(extractAntigravityCli(tarGz([{ name: 'antigravity', data }]), file, recipe), /real directory/);
  const link = join(root, 'link');
  await mkdir(join(root, 'target'));
  await symlink(join(root, 'target'), link);
  await assert.rejects(extractAntigravityCli(tarGz([{ name: 'antigravity', data }]), link, recipe), /real directory/);
});

test('the darwin product tar.gz is reproducible, holds only agy and has no gzip timestamp', {
  skip: process.platform !== 'darwin' ? 'The pinned Dev product uses macOS bsdtar.' : false,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'cli');
  await mkdir(runtimeRoot);
  await writeFile(join(runtimeRoot, 'agy'), 'cli-bytes');
  const first = join(root, 'first.tar.gz');
  const second = join(root, 'second.tar.gz');
  await packAntigravityCli(runtimeRoot, first, join(root, 'list-a'));
  const later = new Date('2026-10-13T00:00:00.000Z');
  await chmod(join(runtimeRoot, 'agy'), 0o600);
  await utimes(join(runtimeRoot, 'agy'), later, later);
  await packAntigravityCli(runtimeRoot, second, join(root, 'list-b'));
  const packed = await readFile(first);
  assert.deepEqual(packed, await readFile(second));
  assert.equal(packed[0], 0x1f);
  assert.equal(packed[1], 0x8b);
  assert.equal(packed.readUInt32LE(4), 0);
  const recipe = { ...recipeFor(Buffer.from('cli-bytes'), 'agy') };
  assert.deepEqual(readAntigravityCliBinary(packed, recipe), Buffer.from('cli-bytes'));

  await writeFile(join(runtimeRoot, 'extra'), 'x');
  await assert.rejects(packAntigravityCli(runtimeRoot, join(root, 'third.tar.gz'), join(root, 'list-c')),
    /pinned member/);
});

test('an archive other than the pinned official archive is rejected before packing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'agy.tar.gz');
  await writeFile(archive, Buffer.from('not the official archive'));
  await assert.rejects(buildAntigravityRuntimeCandidate(join(root, 'out'), join(root, 'work'), {
    archivePath: archive,
  }), /pinned recipe/);
  const link = join(root, 'linked.tar.gz');
  await symlink(archive, link);
  await assert.rejects(buildAntigravityRuntimeCandidate(join(root, 'out-2'), join(root, 'work-2'), {
    archivePath: link,
  }), /regular file/);

  const sameSize = join(root, 'same-size.tar.gz');
  const file = await open(sameSize, 'wx');
  try { await file.truncate(antigravityRuntimeSource.sourceSize); }
  finally { await file.close(); }
  await assert.rejects(buildAntigravityRuntimeCandidate(join(root, 'out-3'), join(root, 'work-3'), {
    archivePath: sameSize,
  }), error => {
    assert.match(error.message, /"stage":"file-integrity"/);
    assert.match(error.message, /"actualSize":86506312/);
    assert.match(error.message, /"actualSha256":"[a-f0-9]{64}"/);
    assert.match(error.message, /"expectedSha256":"ba47202f/);
    return true;
  });
});

test('download requests identity bytes and distinguishes HTTP, encoding, declared and actual size failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: 'http', response: () => new Response('private response body', { status: 503 }), error: /download failed \(503\)/ },
    { name: 'no-body', response: () => new Response(null), error: /download failed \(200\)/ },
    { name: 'encoded', response: () => new Response('private response body', { headers: { 'content-encoding': 'gzip', 'content-length': '111404059' } }), error: /"stage":"content-encoding".*"declaredSize":111404059/ },
    { name: 'declared', response: () => new Response('private response body', { headers: { 'content-length': '111404059' } }), error: /"stage":"content-length".*"declaredSize":111404059/ },
    { name: 'short', response: () => new Response('tgz', { headers: { 'content-length': String(antigravityRuntimeSource.sourceSize) } }), error: /"stage":"download-size".*"declaredSize":86506312,"actualSize":3/ },
    { name: 'unknown-length', response: () => new Response('tgz'), error: /"stage":"download-size".*"declaredSize":null,"actualSize":3/ },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const work = join(root, fixture.name);
      let calls = 0;
      await assert.rejects(buildAntigravityRuntimeCandidate(join(work, 'out'), work, {
        fetch: async (url, init) => {
          calls += 1;
          assert.equal(url, antigravityRuntimeSource.sourceUrl);
          assert.equal(new Headers(init.headers).get('accept-encoding'), 'identity');
          assert.equal(init.redirect, 'follow');
          assert.ok(init.signal instanceof AbortSignal);
          return fixture.response();
        },
      }), error => {
        assert.match(error.message, fixture.error);
        assert.doesNotMatch(error.message, /private response body/);
        return true;
      });
      assert.equal(calls, 1);
      await assert.rejects(lstat(join(work, 'agy-cli-source.tar.gz')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(work, 'antigravity-cli')), { code: 'ENOENT' });
    });
  }
});
