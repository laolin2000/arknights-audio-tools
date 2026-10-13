// UnityFS AssetBundle 解析器（参考 AssetStudio BundleFile.cs）
// 用法: node extract_ab.js <input.ab> <outdir>
'use strict';
const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
const outDir = process.argv[3];
if (!filePath || !outDir) { console.error('usage: node extract_ab.js <input.ab> <outdir>'); process.exit(1); }

const buf = fs.readFileSync(filePath);

function readString0(b, off) {
  let i = off;
  while (b[i] !== 0) i++;
  return { s: b.toString('utf8', off, i), end: i + 1 };
}

// 原始 LZ4 block 解压
function lz4Decode(src, srcStart, srcEnd, dst, dstStart) {
  let si = srcStart, di = dstStart;
  while (si < srcEnd) {
    const token = src[si++];
    let litLen = token >> 4;
    if (litLen === 15) {
      let b;
      do { b = src[si++]; litLen += b; } while (b === 255);
    }
    src.copy(dst, di, si, si + litLen);
    si += litLen; di += litLen;
    if (si >= srcEnd) break;
    const offset = src[si] | (src[si + 1] << 8);
    si += 2;
    if (offset === 0 || offset > di) throw new Error('bad offset ' + offset + ' at di=' + di);
    let matchLen = (token & 0xF) + 4;
    if ((token & 0xF) === 15) {
      let b;
      do { b = src[si++]; matchLen += b; } while (b === 255);
    }
    for (let i = 0; i < matchLen; i++) { dst[di] = dst[di - offset]; di++; }
  }
  return di - dstStart;
}

// ---- 头部解析（大端序，与 AssetStudio FileReader 一致）----
let o = 0;
const sig = buf.toString('utf8', 0, 8);
if (!sig.startsWith('UnityFS')) { console.error('不是 UnityFS 文件'); process.exit(1); }
const version = buf.readUInt32BE(8);
let r = readString0(buf, 12);               // unityVersion
const unityVersion = r.s;
r = readString0(buf, r.end);                // unityRevision
const unityRevision = r.s;
const size = Number(buf.readBigInt64BE(r.end));
const compBlocksInfoSize = buf.readUInt32BE(r.end + 8);
const uncompBlocksInfoSize = buf.readUInt32BE(r.end + 12);
const flags = buf.readUInt32BE(r.end + 16);
let blocksInfoStart = Math.ceil((r.end + 20) / 16) * 16; // AlignStream(16)

const compressionType = flags & 0x3f; // 0=None 1=Lzma 2=Lz4 3=Lz4HC
console.log('=== UnityFS 头 ===');
console.log('signature:', sig, '| version:', version);
console.log('unityVersion:', unityVersion, '| unityRevision:', unityRevision);
console.log('fileSize字段:', size, '| 实际文件大小:', buf.length);
console.log('blocksInfo: 压缩', compBlocksInfoSize, '-> 解压', uncompBlocksInfoSize);
console.log('flags: 0x' + flags.toString(16), '| 压缩类型:', compressionType, '(0=None 1=Lzma 2=Lz4 3=Lz4HC)');
console.log('blocksInfo 起始偏移: 0x' + blocksInfoStart.toString(16));

// ---- 块信息区 ----
const compInfo = buf.slice(blocksInfoStart, blocksInfoStart + compBlocksInfoSize);
let infoBuf;
let nWritten = 0;
if (compressionType === 0) {
  infoBuf = compInfo;
  nWritten = compInfo.length;
} else {
  infoBuf = Buffer.alloc(uncompBlocksInfoSize);
  nWritten = lz4Decode(compInfo, 0, compInfo.length, infoBuf, 0);
  if (nWritten !== uncompBlocksInfoSize) {
    console.error('LZ4 解压失败: 得到', nWritten, '期望', uncompBlocksInfoSize);
    process.exit(1);
  }
}
console.log('块信息区 LZ4 解压成功:', nWritten, '/', uncompBlocksInfoSize);

// 解析块信息（大小端都试，取能通过合理性校验的那个）
function tryParseInfo(b, be) {
  try {
    let p = 0;
    const hash = b.slice(0, 16);
    const rd32 = be ? (off) => b.readUInt32BE(off) : (off) => b.readUInt32LE(off);
    const rd16 = be ? (off) => b.readUInt16BE(off) : (off) => b.readUInt16LE(off);
    const rdi64 = be ? (off) => Number(b.readBigInt64BE(off)) : (off) => Number(b.readBigInt64LE(off));
    p += 16;
    const blockCount = rd32(p); p += 4;
    if (blockCount < 1 || blockCount > 128) return null;
    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
      const uncompressedSize = rd32(p); p += 4;
      const compressedSize = rd32(p); p += 4;
      const f = rd16(p); p += 2;
      if (compressedSize > buf.length) return null;
      blocks.push({ uncompressedSize, compressedSize, flags: f });
    }
    const nodeCount = rd32(p); p += 4;
    if (nodeCount < 0 || nodeCount > 128) return null;
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      const offset = rdi64(p); p += 8;
      const nsize = rdi64(p); p += 8;
      const nflags = rd32(p); p += 4;
      const r2 = readString0(b, p);
      p = r2.end;
      if (!/^[\x20-\x7e\.\/\\-]+$/.test(r2.s)) return null;
      nodes.push({ offset, size: nsize, flags: nflags, path: r2.s });
    }
    return { blocks, nodes, hash };
  } catch (e) { return null; }
}

let info = tryParseInfo(infoBuf, true) || tryParseInfo(infoBuf, false);
if (!info) { console.error('块信息解析失败'); process.exit(1); }
console.log('\n=== 块信息 ===');
console.log('dataHash:', info.hash.toString('hex'));
console.log('存储块数:', info.blocks.length, '| 节点数:', info.nodes.length);
let sumUncomp = 0, sumComp = 0;
info.blocks.forEach((b, i) => {
  sumUncomp += b.uncompressedSize; sumComp += b.compressedSize;
  console.log(`  block[${i}]: compressed=${b.compressedSize} uncompressed=${b.uncompressedSize} flags=0x${b.flags.toString(16)} (压缩类型: ${b.flags & 0x3f})`);
});
console.log('块压缩合计:', sumComp, '-> 解压合计:', sumUncomp);

// ---- 存储块数据起始位置（BlockInfoNeedPaddingAtStart=0x200 时对齐 16）----
let blockDataStart = blocksInfoStart + compBlocksInfoSize;
if (flags & 0x200) blockDataStart = Math.ceil(blockDataStart / 16) * 16;
console.log('存储块数据起始: 0x' + blockDataStart.toString(16), '(文件大小 0x' + buf.length.toString(16) + ')');

// ---- 解压所有块（LZHAM 暂时跳过，只解 LZ4/未压缩）----
const blocksStream = Buffer.alloc(sumUncomp);
let w = 0;
let skippedLzham = false;
for (let i = 0; i < info.blocks.length; i++) {
  const b = info.blocks[i];
  const ct = b.flags & 0x3f;
  if (ct === 0) {
    buf.copy(blocksStream, w, blockDataStart, blockDataStart + b.compressedSize);
    w += b.compressedSize;
  } else if (ct === 2 || ct === 3) {
    const n = lz4Decode(buf, blockDataStart, blockDataStart + b.compressedSize, blocksStream, w);
    if (n !== b.uncompressedSize) { console.error(`block[${i}] LZ4 解压长度不符: ${n} vs ${b.uncompressedSize}`); process.exit(1); }
    w += n;
  } else {
    console.error(`block[${i}] 压缩类型 ${ct} 暂不支持(LZHAM)，跳过 ${b.compressedSize} 字节`);
    skippedLzham = true;
    w += b.uncompressedSize; // 保持输出流位置正确
  }
  blockDataStart += b.compressedSize;
}
console.log('存储块解压完成:', w, '/', sumUncomp, skippedLzham ? '(含 LZHAM 跳过)' : '');

// ---- 导出节点 ----
fs.mkdirSync(outDir, { recursive: true });
const fileMeta = [];
for (const node of info.nodes) {
  console.log(`节点 "${node.path}" offset=${node.offset} size=${node.size}`);
  if (node.offset + node.size > sumUncomp) {
    console.log(`   ⚠ 节点数据位于 LZHAM 块内（offset+size=${node.offset + node.size} > 已解压 ${sumUncomp}），暂无法完整提取`);
    continue;
  }
  const data = Buffer.from(blocksStream.slice(node.offset, node.offset + node.size));
  const safeName = path.basename(node.path) || ('node_' + fileMeta.length);
  const outPath = path.join(outDir, safeName);
  fs.writeFileSync(outPath, data);
  const magic = data.length >= 8 ? data.slice(0, 8).toString('hex') : data.toString('hex');
  const ascii = data.length >= 8 ? data.slice(0, 8).toString('latin1') : '';
  fileMeta.push({ path: node.path, size: node.size, offset: node.offset, magic, ascii, outPath });
  console.log(`   已导出 -> ${outPath}`);
  console.log(`   前8字节: ${magic}  ascii: "${ascii.replace(/[^\x20-\x7e]/g, '.')}"`);
}
console.log('\n完成，共导出', fileMeta.length, '个文件到', outDir);
