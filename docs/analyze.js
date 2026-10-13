// 双库音频分析: 提取每个 AB 的 FSB5 库, 逐个解码并计算起始能量/时长/循环标志
// 用法: node analyze.js <ab文件...>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = 'C:\\Users\\reskipeer\\.dsh\\skills\\arknights-audio\\tools';
const LZHAM = path.join(TOOLS, 'lzham-ab-decompressor.exe');
const VGM = path.join(TOOLS, 'vgmstream', 'vgmstream-cli.exe');

function readString0(b, off) { let i = off; while (b[i] !== 0) i++; return { s: b.toString('utf8', off, i), end: i + 1 }; }

function parseHeader(buf) {
  let r = readString0(buf, 12);
  r = readString0(buf, r.end);
  const compInfoSize = buf.readUInt32BE(r.end + 8);
  const flags = buf.readUInt32BE(r.end + 16);
  return { compInfoSize, flags, blocksInfoStart: Math.ceil((r.end + 20) / 16) * 16 };
}

function parseBlocksInfo(infoBuf) {
  let p = 16;
  const blockCount = infoBuf.readUInt32BE(p); p += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    blocks.push({ uncompressedSize: infoBuf.readUInt32BE(p), compressedSize: infoBuf.readUInt32BE(p + 4), flags: infoBuf.readUInt16BE(p + 8) });
    p += 10;
  }
  const nodeCount = infoBuf.readUInt32BE(p); p += 4;
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = Number(infoBuf.readBigInt64BE(p)); p += 8;
    const nsize = Number(infoBuf.readBigInt64BE(p)); p += 8;
    infoBuf.readUInt32BE(p); p += 4;
    const r = readString0(infoBuf, p); p = r.end;
    nodes.push({ offset, size: nsize, path: r.s });
  }
  return { blocks, nodes };
}

function extractNodes(abPath, tmpDir) {
  const stem = path.basename(abPath, '.ab');
  const unpacked = path.join(tmpDir, stem + '_u.ab');
  execFileSync(LZHAM, ['--game', 'arknights', abPath, unpacked], { stdio: 'pipe' });
  const buf = fs.readFileSync(unpacked);
  const hdr = parseHeader(buf);
  const infoBuf = buf.slice(hdr.blocksInfoStart, hdr.blocksInfoStart + hdr.compInfoSize);
  const { blocks, nodes } = parseBlocksInfo(infoBuf);
  let dataStart = hdr.blocksInfoStart + hdr.compInfoSize;
  if (hdr.flags & 0x200) dataStart = Math.ceil(dataStart / 16) * 16;
  const total = blocks.reduce((a, b) => a + b.uncompressedSize, 0);
  const stream = Buffer.alloc(total);
  let w = 0;
  for (const b of blocks) {
    buf.copy(stream, w, dataStart, dataStart + b.compressedSize);
    w += b.compressedSize;
    dataStart += b.compressedSize;
  }
  const out = {};
  for (const n of nodes) out[n.path] = Buffer.from(stream.slice(n.offset, n.offset + n.size));
  return out;
}

function splitFsb5(resBuf) {
  const starts = [];
  let idx = resBuf.indexOf(Buffer.from('FSB5'));
  while (idx !== -1) { starts.push(idx); idx = resBuf.indexOf(Buffer.from('FSB5'), idx + 1); }
  return starts.map((s, i) => resBuf.slice(s, i + 1 < starts.length ? starts[i + 1] : resBuf.length));
}

function wavStats(p) {
  const b = fs.readFileSync(p);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4);
    const sz = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { rate: b.readUInt32LE(pos + 12), ch: b.readUInt16LE(pos + 10), bits: b.readUInt16LE(pos + 22) };
    if (id === 'data') { data = { off: pos + 8, size: sz }; break; }
    pos += 8 + sz + (sz % 2);
  }
  if (!fmt || !data) throw new Error('no fmt/data');
  const bps = fmt.bits / 8;
  const samples = data.size / (bps * fmt.ch);
  const win = Math.floor(fmt.rate * 0.1); // 100ms 窗口
  const winRms = [];
  for (let w = 0; w * win * bps * fmt.ch < data.size; w++) {
    let sum = 0, n = 0;
    for (let i = w * win * bps * fmt.ch; i < Math.min(data.size, (w + 1) * win * bps * fmt.ch); i += bps) {
      const v = fmt.bits === 16 ? b.readInt16LE(data.off + i) / 32768 : 0;
      sum += v * v; n++;
    }
    winRms.push(n ? Math.sqrt(sum / n) : 0);
  }
  const overall = Math.sqrt(winRms.reduce((a, x) => a + x * x, 0) / Math.max(1, winRms.length));
  const rmsOf = (n) => Math.sqrt(winRms.slice(0, n).reduce((a, x) => a + x * x, 0) / Math.max(1, Math.min(n, winRms.length)));
  let attack = -1;
  for (let i = 0; i < winRms.length; i++) { if (winRms[i] >= 0.3 * overall) { attack = Math.round(i * 0.1 * 10) / 10; break; } }
  return {
    rate: fmt.rate, ch: fmt.ch, seconds: Math.round(samples / fmt.rate * 10) / 10,
    overall: +overall.toFixed(4), rms50: +rmsOf(0.5).toFixed(4), rms250: +rmsOf(2.5).toFixed(4), rms1s: +rmsOf(10).toFixed(4),
    attack: attack
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkana-'));
for (const abPath of process.argv.slice(2)) {
  const stem = path.basename(abPath, '.ab');
  console.log('\n===== ' + stem + ' =====');
  const nodes = extractNodes(abPath, tmpDir);
  const resKeys = Object.keys(nodes).filter(k => k.endsWith('.resource'));
  const cabKey = Object.keys(nodes).find(k => k.startsWith('CAB-') && !k.includes('.'));
  if (!resKeys.length) { console.log('  无 .resource'); continue; }
  const resBuf = nodes[resKeys[0]];
  const banks = splitFsb5(resBuf);
  console.log('  .resource 大小: ' + resBuf.length + ' | FSB5 库数: ' + banks.length + ' | 各库起点: ' + banks.map(() => '').join(''));
  if (cabKey) fs.writeFileSync(path.join(tmpDir, stem + '_cab.bin'), nodes[cabKey]);
  banks.forEach((bank, i) => {
    const fsb = path.join(tmpDir, stem + '_b' + (i + 1) + '.fsb');
    const wav = path.join(tmpDir, stem + '_b' + (i + 1) + '.wav');
    fs.writeFileSync(fsb, bank);
    let info = '';
    try { info = execFileSync(VGM, ['-i', fsb], { stdio: 'pipe' }).toString(); } catch (e) { info = 'ERROR'; }
    const loopLine = info.split('\n').filter(l => /loop/i.test(l)).map(l => l.trim()).join(' | ');
    try { execFileSync(VGM, ['-o', wav, fsb], { stdio: 'pipe' }); } catch (e) { console.log('  库' + (i + 1) + ' 解码失败: ' + e.message); return; }
    const st = wavStats(wav);
    console.log('  库' + (i + 1) + ': 时长=' + st.seconds + 's ' + st.rate + 'Hz/' + st.ch + 'ch | 起始RMS(50ms/250ms/1s)=' + st.rms50 + '/' + st.rms250 + '/' + st.rms1s + ' | 整体RMS=' + st.overall + ' | 起音时间=' + st.attack + 's | ' + loopLine);
  });
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
