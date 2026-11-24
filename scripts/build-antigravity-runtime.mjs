#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);
const MAX_RUNTIME_ASSET_BYTES = 512 * 1024 * 1024;
const TAR_BLOCK = 512;

/**
 * Pinned official Antigravity CLI (`agy`) for the darwin-arm64 target.
 * Google's release manifest
 * https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json
 * (the one the official installer https://antigravity.google/cli/install.sh
 * reads) names the version, the URL and the SHA-512 below. The archive holds
 * one file, `antigravity`, which the installer installs as `agy`. The product
 * asset repacks exactly those bytes as `agy`, the basename the Proxy launches
 * as `agy acp`; the Runtime id and display name stay the shipped ones.
 */
export const antigravityRuntimeSource = Object.freeze({
  schemaVersion: 1,
  kind: 'antigravity-cli',
  provider: 'antigravity',
  pluginId: 'io.gian.antigravity',
  runtimeId: 'antigravity-acp',
  version: '1.5.16',
  platform: 'darwin-arm64',
  upstreamPlatform: 'darwin_arm64',
  format: 'tar.gz',
  entryRelativePath: 'agy',
  entryMode: 0o755,
  sourceUrl: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/darwin-arm/cli_mac_arm64.tar.gz',
  sourceSha256: 'ba47202f712de4c4a78fd787d81ba206d73e11c97572fc69420f29a77efc8d95',
  sourceSha512: '33f5617dc74fea606d47b2483c6d271c850c9f3c9c55b724c664c3c0d4b82100d819fbcf55714f851765f6628d4296883ac8939b4fdeb55d5e6b9ce923135d18',
  sourceSize: 86506312,
  sourceMember: 'antigravity',
  binarySha256: 'b746bd68eb150f594e53af1e5577c8b101eaf33bd44ca10ac683af90e0630cf3',
  binarySize: 230641440,
});

function digest(bytes, algorithm = 'sha256') {
  return createHash(algorithm).update(bytes).digest('hex');
}

function invalidArchive(detail) {
  return new Error(`Antigravity source archive is invalid${detail ? `: ${detail}` : ''}.`);
}

function tarString(header, start, length) {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function tarOctal(header, start, length) {
  const text = tarString(header, start, length).trim();
  if (!/^[0-7]+$/u.test(text)) throw invalidArchive('non-octal header field');
  return Number.parseInt(text, 8);
}

function tarChecksumOk(header) {
  const recorded = tarOctal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum === recorded;
}

/**
 * Read the official archive: exactly one regular file named
 * `sourceMember`, of the pinned size and digest, followed only by the
 * end-of-archive zero blocks. No member name ever becomes an output path.
 */
export function readAntigravityCliBinary(archiveBytes, recipe = antigravityRuntimeSource) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length === 0 || archiveBytes.length > MAX_RUNTIME_ASSET_BYTES) {
    throw invalidArchive();
  }
  let tar;
  try {
    tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_RUNTIME_ASSET_BYTES });
  } catch {
    throw invalidArchive('gzip');
  }
  if (tar.length < TAR_BLOCK * 3 || tar.length % TAR_BLOCK !== 0) throw invalidArchive('tar length');
  const header = tar.subarray(0, TAR_BLOCK);
  if (!tarChecksumOk(header)) throw invalidArchive('header checksum');
  const magic = header.subarray(257, 265).toString('latin1');
  if (magic !== 'ustar\u000000' && magic !== 'ustar  \u0000') throw invalidArchive('not ustar');
  const type = String.fromCharCode(header[156]);
  if (type !== '0' && type !== '\u0000') throw invalidArchive('member is not a regular file');
  const prefix = tarString(header, 345, 155);
  const name = tarString(header, 0, 100);
  if (prefix !== '' || name !== recipe.sourceMember) {
    throw invalidArchive('unexpected member');
  }
  const size = tarOctal(header, 124, 12);
  if (size !== recipe.binarySize) throw invalidArchive('member size');
  const dataEnd = TAR_BLOCK + size;
  const paddedEnd = TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  if (paddedEnd + TAR_BLOCK * 2 > tar.length) throw invalidArchive('truncated');
  for (let index = dataEnd; index < tar.length; index += 1) {
    if (tar[index] !== 0) throw invalidArchive('more than one member');
  }
  const binary = Buffer.from(tar.subarray(TAR_BLOCK, dataEnd));
  if (digest(binary) !== recipe.binarySha256) {
    throw invalidArchive('binary differs from the pinned digest');
  }
  return binary;
}

/** Write the pinned binary as `agy`. Refuses a link or non-directory target. */
export async function extractAntigravityCli(archiveBytes, destination, recipe = antigravityRuntimeSource) {
  const info = await lstat(destination).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error('Antigravity Runtime directory must be a real directory.');
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const binary = readAntigravityCliBinary(archiveBytes, recipe);
  const target = join(destination, antigravityRuntimeSource.entryRelativePath);
  await writeFile(target, binary, { flag: 'wx', mode: antigravityRuntimeSource.entryMode });
  await chmod(target, antigravityRuntimeSource.entryMode);
  return target;
}

async function readPinnedArchive(archivePath) {
  const info = await lstat(archivePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Antigravity source archive must be a regular file.');
  }
  if (info.size !== antigravityRuntimeSource.sourceSize) {
    throw archiveMismatch('file-size', { actualSize: info.size });
  }
  const bytes = await readFile(archivePath);
  const actualSha256 = digest(bytes);
  if (bytes.length !== antigravityRuntimeSource.sourceSize
    || actualSha256 !== antigravityRuntimeSource.sourceSha256
    || digest(bytes, 'sha512') !== antigravityRuntimeSource.sourceSha512) {
    throw archiveMismatch('file-integrity', { actualSize: bytes.length, actualSha256 });
  }
  return bytes;
}

function archiveMismatch(stage, observed) {
  return new Error(`Antigravity source archive differs from the pinned recipe. ${JSON.stringify({
    stage,
    expectedSize: antigravityRuntimeSource.sourceSize,
    expectedSha256: antigravityRuntimeSource.sourceSha256,
    ...observed,
  })}`);
}

async function downloadAntigravitySource(destination, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(antigravityRuntimeSource.sourceUrl, {
    headers: { 'Accept-Encoding': 'identity' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Antigravity source archive download failed (${response.status}).`);
  }
  const declared = response.headers.get('content-length');
  const declaredSize = declared === null ? null : Number(declared);
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  // Fetch decodes HTTP compression, while Content-Length counts encoded
  // bytes. Require identity before comparing it with the pinned size.
  if (encoding && encoding !== 'identity') {
    await response.body.cancel().catch(() => undefined);
    throw archiveMismatch('content-encoding', { declaredSize, contentEncoding: 'non-identity' });
  }
  if (declared !== null && Number(declared) !== antigravityRuntimeSource.sourceSize) {
    await response.body.cancel().catch(() => undefined);
    throw archiveMismatch('content-length', { declaredSize });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      received += step.value.byteLength;
      if (received > antigravityRuntimeSource.sourceSize) {
        throw archiveMismatch('download-size', { declaredSize, actualSize: received });
      }
      chunks.push(Buffer.from(step.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (received !== antigravityRuntimeSource.sourceSize) {
    throw archiveMismatch('download-size', { declaredSize, actualSize: received });
  }
  await writeFile(destination, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
  return destination;
}

/** Deterministic product archive: the single `agy` member with fixed
 * owner, mode and time, no extended metadata and no gzip timestamp. */
export async function packAntigravityCli(runtimeRoot, archivePath, listPath) {
  const name = antigravityRuntimeSource.entryRelativePath;
  const present = await readdir(runtimeRoot);
  if (present.length !== 1 || present[0] !== name) {
    throw new Error('Antigravity Runtime directory does not match the pinned member.');
  }
  const path = join(runtimeRoot, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Antigravity Runtime member must be a regular file.');
  }
  const epoch = new Date('2000-01-01T00:00:00.000Z');
  await chmod(path, 0o644);
  await utimes(path, epoch, epoch);
  await chmod(path, antigravityRuntimeSource.entryMode);
  await writeFile(listPath, Buffer.from(`${name}\0`, 'utf8'));
  await execFileAsync('/usr/bin/tar', [
    '-czhf', archivePath,
    '--format', 'ustar',
    '--uid', '0',
    '--gid', '0',
    '--uname', 'root',
    '--gname', 'root',
    '--numeric-owner',
    '--no-xattrs',
    '--no-acls',
    '--no-fflags',
    '--no-mac-metadata',
    '--options', 'gzip:!timestamp',
    '-C', runtimeRoot,
    '--null',
    '-T', listPath,
  ], {
    maxBuffer: 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = await readFile(archivePath);
  if (bytes.length === 0 || bytes.length > MAX_RUNTIME_ASSET_BYTES) {
    throw new Error('Antigravity Runtime archive exceeds the size limit.');
  }
  return bytes;
}

/** Build the managed Runtime asset. `options.archivePath` selects an already
 * cached official archive; omitting it downloads the pinned URL. This does
 * not spawn the CLI, a model or the App, and does not consult proxy release
 * metadata. */
export async function buildAntigravityRuntimeCandidate(outputDir, workDir, options = {}) {
  if (!outputDir || !workDir) throw new Error('Antigravity Runtime build requires output and work directories.');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const archivePath = options.archivePath
    ?? await downloadAntigravitySource(join(workDir, 'agy-cli-source.tar.gz'), options.fetch);
  const bytes = await readPinnedArchive(archivePath);
  const runtimeRoot = join(workDir, 'antigravity-cli');
  const entry = await extractAntigravityCli(bytes, runtimeRoot);
  const name = `gian-runtime-antigravity-${antigravityRuntimeSource.version}-darwin-arm64.tar.gz`;
  const path = join(outputDir, name);
  const packed = await packAntigravityCli(runtimeRoot, path, join(workDir, 'antigravity-runtime-files'));
  return {
    provider: antigravityRuntimeSource.provider,
    version: antigravityRuntimeSource.version,
    format: antigravityRuntimeSource.format,
    entryRelativePath: antigravityRuntimeSource.entryRelativePath,
    asset: {
      name,
      path,
      sha256: digest(packed),
      size: packed.length,
      publish: false,
    },
    candidateBin: entry,
  };
}

function hashFile(path) {
  return new Promise((done, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')));
  });
}

function parseArgs(argv) {
  const options = { archivePath: '', outputDir: '', workDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--archive') options.archivePath = argv[++index];
    else if (arg === '--output') options.outputDir = argv[++index];
    else if (arg === '--work') options.workDir = argv[++index];
    else throw new Error(`Unknown Antigravity Runtime argument ${arg}.`);
  }
  if (!options.outputDir || !options.workDir) {
    throw new Error('Antigravity Runtime build requires --output and --work (and optionally --archive).');
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  buildAntigravityRuntimeCandidate(options.outputDir, options.workDir, {
    ...(options.archivePath ? { archivePath: options.archivePath } : {}),
  }).then(async candidate => {
    console.log(JSON.stringify({
      provider: candidate.provider,
      version: candidate.version,
      format: candidate.format,
      entryRelativePath: candidate.entryRelativePath,
      asset: candidate.asset,
      candidateBin: candidate.candidateBin,
      memberSha256: {
        [antigravityRuntimeSource.entryRelativePath]: await hashFile(candidate.candidateBin),
      },
    }, null, 2));
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
