/**
 * 最小 ZIP 读写（store + deflate）——只为「项目数据包」一键导出/导入服务。
 * 不引入外部依赖：压缩用 Node 内置 zlib。中文文件名一律按 UTF-8 写入（通用位标记 bit 11），
 * 读取时兼容外部工具生成的 GBK 名（bit 11 未置且 UTF-8 解码出现替换符时回退 gbk）。
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}

/** CRC-32（zip 用，非加密）。 */
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosStamp(d) {
  const dt = d instanceof Date ? d : new Date();
  const time = ((dt.getHours() & 31) << 11) | ((dt.getMinutes() & 63) << 5) | ((Math.floor(dt.getSeconds() / 2)) & 31);
  const date = (((dt.getFullYear() - 1980) & 127) << 9) | (((dt.getMonth() + 1) & 15) << 5) | (dt.getDate() & 31);
  return { time, date };
}

/** 递归收集目录下的普通文件（跳过符号链接），返回 [{abs, rel}]。 */
function walkFiles(srcDir, opts) {
  const out = [];
  const walk = (dir, prefix) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(abs, rel); continue; }
      if (!st.isFile()) continue;
      if (opts && typeof opts.filter === 'function' && !opts.filter(rel, abs)) continue;
      out.push({ abs, rel, size: st.size, mtime: st.mtime });
    }
  };
  walk(srcDir, '');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * 把 srcDir 打包成 zipPath（目录内相对路径即包内路径）。
 * opts.prefix：给所有条目加一层前缀（导出单个项目时用项目文件夹名）。
 */
export function zipDirectory(srcDir, zipPath, opts = {}) {
  const files = walkFiles(srcDir, opts);
  const prefix = String(opts.prefix || '').replace(/^\/+|\/+$/g, '');
  const fd = openSync(zipPath, 'w');
  let offset = 0;
  const central = [];
  const put = (buf) => { writeSync(fd, buf, 0, buf.length, offset); offset += buf.length; };
  const MAX32 = 0xFFFEFEFE;
  try {
    for (const f of files) {
      let raw;
      try { raw = readFileSync(f.abs); } catch { continue; }
      let method = 8;
      let data = zlib.deflateRawSync(raw, { level: 6 });
      if (data.length >= raw.length) { method = 0; data = raw; }
      const entryName = prefix ? prefix + '/' + f.rel : f.rel;
      const nameBuf = Buffer.from(entryName, 'utf8');
      const { time, date } = dosStamp(f.mtime);
      const crc = crc32(raw);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      const headerOffset = offset;
      put(local); put(nameBuf); put(data);
      if (offset > MAX32) throw new Error('数据包超过 4GB，请分成多个项目分别导出');
      central.push({ nameBuf, method, time, date, crc, csize: data.length, usize: raw.length, headerOffset });
    }
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20);
      h.writeUInt32LE(c.usize, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(0, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE(0, 38);
      h.writeUInt32LE(c.headerOffset, 42);
      put(h); put(c.nameBuf);
    }
    const cdSize = offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    put(eocd);
  } finally {
    closeSync(fd);
  }
  return { ok: true, file: zipPath, entries: central.length, bytes: offset };
}

/** 包内路径净化：拒绝绝对路径、盘符与上跳。返回 posix 相对路径或 null。 */
function safeRel(name) {
  const clean = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || /^[a-zA-Z]:/.test(clean)) return null;
  const parts = clean.split('/').filter((s) => s && s !== '.');
  if (!parts.length) return null;
  if (parts.some((s) => s === '..')) return null;
  return parts.join('/');
}

function decodeName(buf, utf8Flag) {
  if (utf8Flag) return buf.toString('utf8');
  const s = buf.toString('utf8');
  if (!s.includes('\uFFFD')) return s;
  try { return new TextDecoder('gbk').decode(buf); } catch { return s; }
}

/** 解压 zipPath 到 destDir（不覆盖 destDir 之外；返回写入的文件清单）。 */
export function unzipTo(zipPath, destDir) {
  const fd = openSync(zipPath, 'r');
  const written = [];
  try {
    const st = fstatSync(fd);
    const tailLen = Math.min(st.size, 66000);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, st.size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 数据包（缺少目录尾）');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    let p = 0;
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x0800) !== 0);
      p += 46 + nameLen + extraLen + commentLen;
      entries.push({ name, method, csize, usize, localOffset });
    }
    for (const e of entries) {
      const safe = safeRel(e.name);
      if (!safe) continue;
      const target = path.join(destDir, ...safe.split('/'));
      if (e.name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue; }
      mkdirSync(path.dirname(target), { recursive: true });
      const lh = Buffer.alloc(30);
      readSync(fd, lh, 0, 30, e.localOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip 局部头损坏：' + e.name);
      const dataOffset = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = Buffer.alloc(e.csize);
      if (e.csize > 0) readSync(fd, comp, 0, e.csize, dataOffset);
      let raw;
      if (e.method === 0) raw = comp;
      else if (e.method === 8) raw = zlib.inflateRawSync(comp);
      else throw new Error('不支持的压缩方式 ' + e.method + '：' + e.name);
      writeFileSync(target, raw);
      written.push({ rel: safe, bytes: raw.length });
    }
  } finally {
    closeSync(fd);
  }
  return { ok: true, files: written.length, entries: written };
}
