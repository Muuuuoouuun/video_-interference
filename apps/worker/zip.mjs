import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** Already-compressed media is stored as is: deflating JPEG/PNG/AAC costs time and saves almost nothing. */
const STORED = /\.(?:jpe?g|png|webp|gif|avif|heic|m4a|mp4|mov|webm|mp3|aac|ogg|flac|zip)$/i;
const MAX32 = 0xFFFFFFFF, MAX16 = 0xFFFF, READ_WHOLE_LIMIT = 32 * 1024 * 1024;

function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

function zip64Extra(size, compressedSize, offset) {
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(size), 4); extra.writeBigUInt64LE(BigInt(compressedSize), 12); extra.writeBigUInt64LE(BigInt(offset), 20);
  return extra;
}

function validName(name) {
  return typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) < MAX16 && !name.startsWith('/') && !name.includes('\\') && !name.includes('\0') && name.split('/').every(part => part && part !== '.' && part !== '..');
}

async function fileCrc(path, signal) {
  let value = 0;
  for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); value = crc32(chunk, value); }
  return value;
}

/**
 * Writes `names` (relative to `root`) into a portable ZIP in one pass without a platform zip binary.
 * The archive is published atomically; a failure or abort leaves no partial file at `outputPath`.
 */
export async function writeZip(root, outputPath, names, { signal, forceZip64 = false } = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(names) || names.some(name => !validName(name)) || new Set(names).size !== names.length) throw new Error('ZIP 항목 이름이 유효하지 않거나 중복됩니다.');
  const partial = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID().slice(0, 8)}.partial`);
  const handle = await open(partial, 'wx');
  let offset = 0, published = false;
  const write = async buffer => { let written = 0; while (written < buffer.length) written += (await handle.write(buffer, written, buffer.length - written, offset + written)).bytesWritten; offset += buffer.length; };
  try {
    const central = [];
    for (const name of names) {
      signal?.throwIfAborted();
      const path = join(root, name), info = await stat(path);
      if (!info.isFile()) throw new Error(`ZIP에 넣을 파일을 찾지 못했습니다: ${name}`);
      const size = info.size, nameBytes = Buffer.from(name, 'utf8'), stamp = dosTime(info.mtime);
      let method = 0, crc, body = null, compressedSize = size;
      if (!STORED.test(name) && size <= READ_WHOLE_LIMIT) {
        const bytes = await readFile(path); crc = crc32(bytes);
        const deflated = deflateRawSync(bytes, { level: 6 });
        if (deflated.length < bytes.length) { method = 8; body = deflated; compressedSize = deflated.length; } else body = bytes;
      } else if (size <= READ_WHOLE_LIMIT) { body = await readFile(path); crc = crc32(body); }
      else crc = await fileCrc(path, signal);
      const localOffset = offset, zip64 = forceZip64 || size >= MAX32 || compressedSize >= MAX32 || localOffset >= MAX32;
      const extra = zip64 ? zip64Extra(size, compressedSize, localOffset) : Buffer.alloc(0), needed = zip64 ? 45 : 20;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(needed, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(method, 8);
      header.writeUInt16LE(stamp.time, 10); header.writeUInt16LE(stamp.date, 12); header.writeUInt32LE(crc >>> 0, 14);
      header.writeUInt32LE(zip64 ? MAX32 : compressedSize, 18); header.writeUInt32LE(zip64 ? MAX32 : size, 22);
      // The local ZIP64 extra holds only the two sizes; the offset lives in the central directory.
      const localExtra = zip64 ? Buffer.concat([Buffer.from([0x01, 0x00, 0x10, 0x00]), extra.subarray(4, 20)]) : extra;
      header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(localExtra.length, 28);
      await write(Buffer.concat([header, nameBytes, localExtra]));
      if (body) await write(body);
      else {
        let copied = 0;
        for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); await write(chunk); copied += chunk.length; }
        if (copied !== size) throw new Error(`ZIP에 넣는 동안 파일이 바뀌었습니다: ${name}`);
      }
      central.push({ nameBytes, method, stamp, crc, size, compressedSize, localOffset, zip64, extra, needed });
    }
    signal?.throwIfAborted();
    const centralOffset = offset;
    for (const entry of central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | entry.needed, 4); record.writeUInt16LE(entry.needed, 6);
      record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(entry.method, 10); record.writeUInt16LE(entry.stamp.time, 12); record.writeUInt16LE(entry.stamp.date, 14);
      record.writeUInt32LE(entry.crc >>> 0, 16); record.writeUInt32LE(entry.zip64 ? MAX32 : entry.compressedSize, 20); record.writeUInt32LE(entry.zip64 ? MAX32 : entry.size, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28); record.writeUInt16LE(entry.extra.length, 30);
      record.writeUInt32LE(((0o100644 << 16) >>> 0), 38); record.writeUInt32LE(entry.zip64 ? MAX32 : entry.localOffset, 42);
      await write(Buffer.concat([record, entry.nameBytes, entry.extra]));
    }
    const centralSize = offset - centralOffset, zip64End = forceZip64 || central.length >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32 || central.some(entry => entry.zip64);
    if (zip64End) {
      const endOffset = offset, record = Buffer.alloc(56), locator = Buffer.alloc(20);
      record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE((3 << 8) | 45, 12); record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(central.length), 24); record.writeBigUInt64LE(BigInt(central.length), 32); record.writeBigUInt64LE(BigInt(centralSize), 40); record.writeBigUInt64LE(BigInt(centralOffset), 48);
      locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(endOffset), 8); locator.writeUInt32LE(1, 16);
      await write(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64End ? MAX16 : central.length, 8); end.writeUInt16LE(zip64End ? MAX16 : central.length, 10);
    end.writeUInt32LE(zip64End ? MAX32 : centralSize, 12); end.writeUInt32LE(zip64End ? MAX32 : centralOffset, 16);
    await write(end);
    await handle.close();
    signal?.throwIfAborted();
    await rename(partial, outputPath); published = true;
    return { entries: central.length, bytes: offset, zip64: zip64End };
  } finally {
    if (!published) { await handle.close().catch(() => {}); await rm(partial, { force: true }); }
  }
}
