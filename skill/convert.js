// 明日方舟音频 AB 转换器（skill: arknights-audio）
// 用法:
//   node convert.js <输入.ab 文件或目录> [输出目录]   # 转换(多段自动合并为一条歌)
//   node convert.js --merge <wav 目录>               # 融合历史 #N 分段文件
// 默认输出目录: D:\TTsongs MM
// 流程: lzham-ab-decompressor(LZ4AK) -> UnityFS 解析 -> 提取 .resource(FSB5) -> vgmstream -> WAV -> 多段融合
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = path.join(__dirname, 'tools');
const LZHAM_EXE = path.join(TOOLS, 'lzham-ab-decompressor.exe');
const VGMSTREAM_EXE = path.join(TOOLS, 'vgmstream', 'vgmstream-cli.exe');
const DEFAULT_OUT = 'D:\\TTsongs MM';

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }

function readString0(b, off) {
  let i = off;
  while (b[i] !== 0) i++;
  return { s: b.toString('utf8', off, i), end: i + 1 };
}

// 解析 UnityFS 头部（大端序），返回 { headerEnd, blocksInfoStart, flags, ... }
function parseHeader(buf) {
  if (!buf.toString('latin1', 0, 7).startsWith('UnityFS')) throw new Error('不是 UnityFS 文件');
  const version = buf.readUInt32BE(8);
  let r = readString0(buf, 12);
  r = readString0(buf, r.end);
  const size = Number(buf.readBigInt64BE(r.end));
  const compInfoSize = buf.readUInt32BE(r.end + 8);
  const uncompInfoSize = buf.readUInt32BE(r.end + 12);
  const flags = buf.readUInt32BE(r.end + 16);
  let blocksInfoStart = Math.ceil((r.end + 20) / 16) * 16; // AlignStream(16)
  if (size !== buf.length) console.warn('⚠ 头部 size 字段 ' + size + ' != 实际 ' + buf.length);
  return { version, compInfoSize, uncompInfoSize, flags, blocksInfoStart };
}

// 解析块信息区（本技能场景:重建后的 AB 为未压缩,仅支持 None）
function parseBlocksInfo(infoBuf) {
  let p = 16; // dataHash
  const blockCount = infoBuf.readUInt32BE(p); p += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const uncompressedSize = infoBuf.readUInt32BE(p); p += 4;
    const compressedSize = infoBuf.readUInt32BE(p); p += 4;
    const f = infoBuf.readUInt16BE(p); p += 2;
    blocks.push({ uncompressedSize, compressedSize, flags: f });
  }
  const nodeCount = infoBuf.readUInt32BE(p); p += 4;
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = Number(infoBuf.readBigInt64BE(p)); p += 8;
    const nsize = Number(infoBuf.readBigInt64BE(p)); p += 8;
    infoBuf.readUInt32BE(p); p += 4; // flags
    const r = readString0(infoBuf, p); p = r.end;
    nodes.push({ offset, size: nsize, path: r.s });
  }
  return { blocks, nodes };
}

// 从 AudioClip 元数据(CAB 节点)里找剪辑名: 优先 <stem>_loop
function findClipName(cabBuf, stem) {
  const strings = cabBuf.toString('latin1').match(/[\x20-\x7e]{4,}/g) || [];
  const norm = strings.map(s => (s.endsWith('.ogg') ? s.slice(0, -4) : s));
  const want = stem + '_loop';
  if (norm.includes(want)) return want;
  const alt = norm.find(s => s.startsWith(stem) && s.endsWith('_loop'));
  return alt || stem;
}

// 解一个 AB: 返回 { ab, clipName, fsbPath, subsongs }
function convertOne(abPath, tmpDir, outDir) {
  const stem = path.basename(abPath, path.extname(abPath));
  console.log('▶ ' + abPath);

  // 1) LZ4AK 解压 (方舟魔改 LZ4, 伪装 LZHAM)
  const unpacked = path.join(tmpDir, stem + '_unpacked.ab');
  execFileSync(LZHAM_EXE, ['--game', 'arknights', abPath, unpacked], { stdio: 'pipe' });

  // 2) UnityFS 解析
  const buf = fs.readFileSync(unpacked);
  const hdr = parseHeader(buf);
  const infoBuf = buf.slice(hdr.blocksInfoStart, hdr.blocksInfoStart + hdr.compInfoSize);
  if ((hdr.flags & 0x3f) !== 0) throw new Error('块信息区压缩类型 ' + (hdr.flags & 0x3f) + ' 不支持(重建文件应为未压缩)');
  const { blocks, nodes } = parseBlocksInfo(infoBuf);

  // 3) 解块(全部应为未压缩)并导出节点
  let dataStart = hdr.blocksInfoStart + hdr.compInfoSize;
  if (hdr.flags & 0x200) dataStart = Math.ceil(dataStart / 16) * 16;
  const total = blocks.reduce((a, b) => a + b.uncompressedSize, 0);
  const stream = Buffer.alloc(total);
  let w = 0;
  for (const b of blocks) {
    if ((b.flags & 0x3f) !== 0) throw new Error('存储块压缩类型 ' + (b.flags & 0x3f) + ' 不支持(应为未压缩)');
    buf.copy(stream, w, dataStart, dataStart + b.compressedSize);
    w += b.compressedSize;
    dataStart += b.compressedSize;
  }

  const resNode = nodes.find(n => n.path.endsWith('.resource'));
  const cabNode = nodes.find(n => n.path.startsWith('CAB-') && !n.path.includes('.'));
  if (!resNode) throw new Error('未找到 .resource 节点(可能不是音频 AB)');
  const resBuf = Buffer.from(stream.slice(resNode.offset, resNode.offset + resNode.size));

  // 4) 剪辑名 + FSB 检查（.resource 可能是多个 FSB5 库拼接，按魔数拆分）
  let clipName = stem;
  let cabBuf = null;
  if (cabNode) {
    cabBuf = Buffer.from(stream.slice(cabNode.offset, cabNode.offset + cabNode.size));
    clipName = findClipName(cabBuf, stem);
  }
  if (resBuf.toString('latin1', 0, 4) !== 'FSB5') throw new Error('.resource 不是 FSB5(magic: ' + resBuf.toString('latin1', 0, 4) + ')');
  const banks = splitFsb5(resBuf);
  console.log('  剪辑名: ' + clipName + ' | FSB5 库数: ' + banks.length);

  // 5) vgmstream 解码（每个库、每个流到临时目录），然后融合为一条歌
  const parts = []; // 临时 WAV 分段(按库顺序)
  for (let bi = 0; bi < banks.length; bi++) {
    const bank = banks[bi].buf;
    const subsongs = bank.readUInt32LE(0x08);
    const fsbPath = path.join(tmpDir, clipName + '#' + (bi + 1) + '.fsb');
    fs.writeFileSync(fsbPath, bank);
    for (let s = 1; s <= subsongs; s++) {
      const partPath = path.join(tmpDir, clipName + '#' + (bi + 1) + (subsongs > 1 ? '_' + s : '') + '.wav');
      const args = subsongs > 1 ? ['-s', String(s), '-o', partPath, fsbPath] : ['-o', partPath, fsbPath];
      execFileSync(VGMSTREAM_EXE, args, { stdio: 'pipe' });
      parts.push(partPath);
    }
  }
  const results = [];
  const finalWav = path.join(outDir, clipName + '.wav');
  if (parts.length === 1) {
    fs.copyFileSync(parts[0], finalWav);
    results.push(finalWav);
  } else {
    try {
      // 融合顺序: 优先按 AudioClip 元数据(intro 库在前, 游戏实际播放顺序);
      // 元数据不可用时退回内容检测(开头 1 秒 RMS 最低 = 从静音淡入库在前)
      let ordered = null;
      if (cabBuf && parts.length === banks.length) {
        try {
          const meta = cabMeta(cabBuf, tmpDir);
          if (meta && meta.introOffset !== null) {
            const bi = banks.findIndex(b => meta.introOffset >= b.start && meta.introOffset < b.start + b.buf.length);
            if (bi >= 0) {
              const orderIdx = [bi, ...banks.map((_, i) => i).filter(i => i !== bi)];
              ordered = orderIdx.map(i => parts[i]).filter(Boolean);
              console.log('  融合顺序(元数据): intro 库' + (bi + 1) + ' 在前');
            }
          }
        } catch (e) { ordered = null; }
      }
      if (!ordered) {
        ordered = parts.slice().sort((a, b) => startRms(a) - startRms(b));
        console.log('  融合顺序(内容检测): 静音淡入库在前');
      }
      mergeWavs(ordered, finalWav);
      console.log('  已融合 ' + parts.length + ' 个分段 -> ' + path.basename(finalWav));
      results.push(finalWav);
    } catch (e) {
      // 融合失败(如格式不一致)时退回: 保留 #N 分段文件
      parts.forEach((p, i) => { fs.copyFileSync(p, path.join(outDir, clipName + '#' + (i + 1) + '.wav')); results.push(path.join(outDir, clipName + '#' + (i + 1) + '.wav')); });
      console.warn('  ⚠ 融合失败(已保留分段): ' + e.message);
    }
  }
  return { ab: abPath, clipName, wavs: results };
}

// 拆分可能拼接的多个 FSB5 库（每个库以 FSB5 魔数为界，返回 {start, buf}）
function splitFsb5(resBuf) {
  const starts = [];
  let idx = resBuf.indexOf(Buffer.from('FSB5'));
  while (idx !== -1) { starts.push(idx); idx = resBuf.indexOf(Buffer.from('FSB5'), idx + 1); }
  if (starts.length === 0) throw new Error('.resource 不是 FSB5');
  return starts.map((s, i) => {
    const e = i + 1 < starts.length ? starts[i + 1] : resBuf.length;
    return { start: s, buf: resBuf.slice(s, e) };
  });
}

// 用 Python+UnityPy 读取 CAB 里的 AudioClip 元数据: 返回 {introOffset, introSize} 或 null
function cabMeta(cabBuf, tmpDir) {
  const cabPath = path.join(tmpDir, 'meta_cab.bin');
  fs.writeFileSync(cabPath, cabBuf);
  const out = execFileSync('python', [path.join(__dirname, 'cabinfo.py'), cabPath], { stdio: 'pipe' }).toString();
  const m = out.match(/AudioClip name='[^']*_intro'[^\n]*resOffset=(\d+)[^\n]*resSize=(\d+)/);
  if (!m) return null;
  return { introOffset: parseInt(m[1], 10), introSize: parseInt(m[2], 10) };
}

// ---- WAV 解析与融合 ----
function parseWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF') throw new Error('不是 RIFF WAV');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { audioFormat: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), sampleRate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') { data = { off: p + 8, size: sz }; break; }
    p += 8 + sz + (sz % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块');
  return { fmt, data };
}

// 计算 WAV 开头 1 秒的 RMS(用于判断哪个库是歌曲开头: 从静音淡入的库应排最前)
function startRms(wavPath) {
  const b = fs.readFileSync(wavPath);
  const w = parseWav(b);
  const bps = w.fmt.bits / 8;
  const n = Math.min(w.data.size, Math.floor(w.fmt.sampleRate) * w.fmt.channels * bps);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i += bps) {
    const v = w.fmt.bits === 16 ? b.readInt16LE(w.data.off + i) / 32768 : 0;
    sum += v * v; cnt++;
  }
  return cnt ? Math.sqrt(sum / cnt) : 0;
}

// 将多个同格式 WAV 按顺序拼接为一条歌（16-bit PCM）
function mergeWavs(parts, outPath) {
  if (parts.length < 2) throw new Error('至少需要 2 个分段');
  const bufs = parts.map(p => { const b = fs.readFileSync(p); return { buf: b, w: parseWav(b) }; });
  const ref = bufs[0].w.fmt;
  for (const { w } of bufs) {
    const f = w.fmt;
    if (f.audioFormat !== ref.audioFormat || f.channels !== ref.channels || f.sampleRate !== ref.sampleRate || f.bits !== ref.bits) {
      throw new Error('分段格式不一致(' + f.sampleRate + 'Hz/' + f.channels + 'ch/' + f.bits + 'bit vs ' + ref.sampleRate + 'Hz/' + ref.channels + 'ch/' + ref.bits + 'bit)');
    }
  }
  const totalData = bufs.reduce((a, x) => a + x.w.data.size, 0);
  const out = Buffer.alloc(44 + totalData);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + totalData, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(ref.audioFormat, 20);
  out.writeUInt16LE(ref.channels, 22);
  out.writeUInt32LE(ref.sampleRate, 24);
  out.writeUInt32LE(ref.sampleRate * ref.channels * ref.bits / 8, 28);
  out.writeUInt16LE(ref.channels * ref.bits / 8, 32);
  out.writeUInt16LE(ref.bits, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(totalData, 40);
  let w = 44;
  for (const { buf, w: wi } of bufs) {
    buf.copy(out, w, wi.data.off, wi.data.off + wi.data.size);
    w += wi.data.size;
  }
  fs.writeFileSync(outPath, out);
  return totalData;
}

// 扫描目录,把同前缀的 #N 分段 WAV 融合为一条歌(数字顺序),成功后删除分段
function mergeFolder(folder) {
  if (!fs.existsSync(folder)) { fail('目录不存在: ' + folder); return false; }
  const wavs = fs.readdirSync(folder).filter(f => /\.wav$/i.test(f));
  const groups = new Map(); // base -> [{file, bank, sub}]
  for (const f of wavs) {
    const m = f.match(/^(.+)#(\d+)(?:_(\d+))?\.wav$/i);
    if (!m) continue;
    const base = m[1];
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push({ file: f, bank: parseInt(m[2], 10), sub: m[3] ? parseInt(m[3], 10) : 0 });
  }
  let merged = 0, skipped = 0;
  for (const [base, parts] of groups) {
    if (parts.length < 2) { skipped++; continue; }
    // 歌曲开头判断: 开头 1 秒 RMS 最低(从静音淡入)的库排最前
    parts.sort((a, b) => startRms(path.join(folder, a.file)) - startRms(path.join(folder, b.file)));
    const outPath = path.join(folder, base + '.wav');
    try {
      mergeWavs(parts.map(p => path.join(folder, p.file)), outPath);
      for (const p of parts) fs.unlinkSync(path.join(folder, p.file));
      console.log('✓ ' + parts.map(p => p.file).join(' + ') + ' -> ' + base + '.wav');
      merged++;
    } catch (e) {
      console.error('✗ 融合失败 ' + base + ': ' + e.message + '（保留原分段）');
    }
  }
  console.log('融合完成: ' + merged + ' 组，单段未动 ' + skipped + ' 个');
  return true;
}

// ---- main ----
if (process.argv[2] === '--merge') {
  const folder = process.argv[3];
  if (!folder) { console.log('用法: node convert.js --merge <wav 目录>'); process.exit(1); }
  process.exit(mergeFolder(folder) ? 0 : 1);
}

const input = process.argv[2];
if (!input) { console.log('用法: node convert.js <输入.ab 文件或目录> [输出目录]'); process.exit(1); }
const outDir = process.argv[3] || DEFAULT_OUT;
if (!fs.existsSync(input)) { fail('输入不存在: ' + input); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

let targets = [];
if (fs.statSync(input).isDirectory()) {
  targets = fs.readdirSync(input).filter(f => f.toLowerCase().endsWith('.ab')).map(f => path.join(input, f));
  if (targets.length === 0) { fail('目录里没有 .ab 文件: ' + input); process.exit(1); }
} else {
  targets = [input];
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkaudio-'));
const done = [], failed = [];
try {
  for (const t of targets) {
    try { done.push(convertOne(t, tmpDir, outDir)); }
    catch (e) { failed.push({ file: t, err: e.message }); console.error('✗ 失败: ' + t + ' — ' + e.message); }
  }
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('\n==== 完成 ====');
for (const d of done) for (const w of d.wavs) console.log('✓ ' + w);
if (failed.length) { console.log('失败 ' + failed.length + ' 个:'); failed.forEach(f => console.log('  ✗ ' + f.file + ': ' + f.err)); }
console.log('输出目录: ' + outDir);
process.exit(failed.length ? 1 : 0);
