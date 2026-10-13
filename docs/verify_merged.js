// 最终验证: 融合文件的开头 == intro 库单独解码的完整 WAV (逐字节)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const TOOLS = 'C:\\Users\\reskipeer\\.dsh\\skills\\arknights-audio\\tools';
const LZHAM = path.join(TOOLS, 'lzham-ab-decompressor.exe');
const VGM = path.join(TOOLS, 'vgmstream', 'vgmstream-cli.exe');
const CABINFO = 'C:\\Users\\reskipeer\\.dsh\\skills\\arknights-audio\\cabinfo.py';
const OUT = 'D:\\TTsongs MM';

function readString0(b, off) { let i = off; while (b[i] !== 0) i++; return { s: b.toString('utf8', off, i), end: i + 1 }; }
function parseHeader(buf) {
  let r = readString0(buf, 12); r = readString0(buf, r.end);
  return { compInfoSize: buf.readUInt32BE(r.end + 8), flags: buf.readUInt32BE(r.end + 16), blocksInfoStart: Math.ceil((r.end + 20) / 16) * 16 };
}
function parseBlocksInfo(infoBuf) {
  let p = 16;
  const blockCount = infoBuf.readUInt32BE(p); p += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) { blocks.push({ uncompressedSize: infoBuf.readUInt32BE(p), compressedSize: infoBuf.readUInt32BE(p + 4), flags: infoBuf.readUInt16BE(p + 8) }); p += 10; }
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
  for (const b of blocks) { buf.copy(stream, w, dataStart, dataStart + b.compressedSize); w += b.compressedSize; dataStart += b.compressedSize; }
  const out = {};
  for (const n of nodes) out[n.path] = Buffer.from(stream.slice(n.offset, n.offset + n.size));
  return out;
}
function wavData(p) {
  const b = fs.readFileSync(p);
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4);
    const sz = b.readUInt32LE(pos + 4);
    if (id === 'data') return b.slice(pos + 8, pos + 8 + sz);
    pos += 8 + sz + (sz % 2);
  }
  throw new Error('no data');
}
function findClipName(cabBuf, stem) {
  const strings = cabBuf.toString('latin1').match(/[\x20-\x7e]{4,}/g) || [];
  const norm = strings.map(s => (s.endsWith('.ogg') ? s.slice(0, -4) : s));
  const want = stem + '_loop';
  if (norm.includes(want)) return want;
  const alt = norm.find(s => s.startsWith(stem) && s.endsWith('_loop'));
  return alt || stem;
}

const dirs = process.argv.slice(2);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkvfy-'));
let ok = 0, total = 0;
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ab'))) {
    const abPath = path.join(dir, f);
    const stem = path.basename(f, '.ab');
    const nodes = extractNodes(abPath, tmpDir);
    const resKey = Object.keys(nodes).find(k => k.endsWith('.resource'));
    const cabKey = Object.keys(nodes).find(k => k.startsWith('CAB-') && !k.includes('.'));
    if (!resKey || !cabKey) continue;
    const resBuf = nodes[resKey];
    const starts = [];
    let idx = resBuf.indexOf(Buffer.from('FSB5'));
    while (idx !== -1) { starts.push(idx); idx = resBuf.indexOf(Buffer.from('FSB5'), idx + 1); }
    if (starts.length < 2) { console.log('— ' + stem + ': 单库'); continue; }
    const cabBuf = nodes[cabKey];
    const clipName = findClipName(cabBuf, stem);
    const mergedPath = path.join(OUT, clipName + '.wav');
    if (!fs.existsSync(mergedPath)) { console.log('✗ ' + stem + ': 融合文件缺失 ' + mergedPath); total++; continue; }
    const cabPath = path.join(tmpDir, stem + '_cab.bin');
    fs.writeFileSync(cabPath, cabBuf);
    let introOff = null;
    try {
      const mout = execFileSync('python', [CABINFO, cabPath], { stdio: 'pipe' }).toString();
      const m = mout.match(/AudioClip name='[^']*_intro'[^\n]*resOffset=(\d+)/);
      if (m) introOff = parseInt(m[1], 10);
    } catch (e) { /* ignore */ }
    const introBankIdx = starts.findIndex((s, i) => {
      const e = i + 1 < starts.length ? starts[i + 1] : resBuf.length;
      return introOff !== null && introOff >= s && introOff < e;
    });
    if (introBankIdx < 0) { console.log('✗ ' + stem + ': 无法定位 intro 库'); total++; continue; }
    const introFsb = path.join(tmpDir, stem + '_intro.fsb');
    const introWav = path.join(tmpDir, stem + '_intro.wav');
    const bankEnd = introBankIdx + 1 < starts.length ? starts[introBankIdx + 1] : resBuf.length;
    fs.writeFileSync(introFsb, resBuf.slice(starts[introBankIdx], bankEnd));
    execFileSync(VGM, ['-o', introWav, introFsb], { stdio: 'pipe' });
    const introData = wavData(introWav);
    const mergedData = wavData(mergedPath);
    const n = Math.min(introData.length, mergedData.length);
    let diff = 0;
    for (let i = 0; i < n; i++) if (introData[i] !== mergedData[i]) { diff++; break; }
    const exact = diff === 0 && n === introData.length;
    total++;
    if (exact) ok++;
    console.log((exact ? '✓' : '✗') + ' ' + stem + ' | intro=库' + (introBankIdx + 1) + ' | 融合文件开头与 intro 库' + (exact ? '逐字节一致' : '不一致(差异@' + diff + ')') + ' | 融合时长=' + Math.round(mergedData.length / 4 / 44100 * 10) / 10 + 's');
  }
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log('\n验证结果: ' + ok + '/' + total + ' 通过');
