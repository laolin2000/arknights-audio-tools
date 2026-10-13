// 全量对照验证: 每个 AB 的 intro 库(元数据) 与 静音淡入库(内容检测) 是否一致
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = 'C:\\Users\\reskipeer\\.dsh\\skills\\arknights-audio\\tools';
const LZHAM = path.join(TOOLS, 'lzham-ab-decompressor.exe');
const VGM = path.join(TOOLS, 'vgmstream', 'vgmstream-cli.exe');
const CABINFO = 'C:\\Users\\reskipeer\\Desktop\\DSHstool\\cabinfo.py';

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
function splitFsb5(resBuf) {
  const starts = [];
  let idx = resBuf.indexOf(Buffer.from('FSB5'));
  while (idx !== -1) { starts.push(idx); idx = resBuf.indexOf(Buffer.from('FSB5'), idx + 1); }
  return starts.map((s, i) => resBuf.slice(s, i + 1 < starts.length ? starts[i + 1] : resBuf.length));
}
function startRms(path, rate, ch, bps, dataOff, dataSize) {
  const b = fs.readFileSync(path);
  const n = Math.min(dataSize, Math.floor(rate) * ch * bps);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i += bps) { const v = b.readInt16LE(dataOff + i) / 32768; sum += v * v; cnt++; }
  return cnt ? Math.sqrt(sum / cnt) : 0;
}
function wavStartRms(wavPath) {
  const b = fs.readFileSync(wavPath);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4);
    const sz = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { rate: b.readUInt32LE(pos + 12), ch: b.readUInt16LE(pos + 10), bits: b.readUInt16LE(pos + 22) };
    if (id === 'data') { data = { off: pos + 8, size: sz }; break; }
    pos += 8 + sz + (sz % 2);
  }
  return startRms(wavPath, fmt.rate, fmt.ch, fmt.bits / 8, data.off, data.size);
}

const dirs = process.argv.slice(2);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkval-'));
let match = 0, total = 0;
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ab'))) {
    const abPath = path.join(dir, f);
    const stem = path.basename(f, '.ab');
    const nodes = extractNodes(abPath, tmpDir);
    const resKey = Object.keys(nodes).find(k => k.endsWith('.resource'));
    const cabKey = Object.keys(nodes).find(k => k.startsWith('CAB-') && !k.includes('.'));
    if (!resKey || !cabKey) continue;
    const banks = splitFsb5(nodes[resKey]);
    if (banks.length < 2) { console.log(stem + ': 单库(无融合)'); continue; }
    // 解码每个库, 算开头 RMS
    const rms = banks.map((bank, i) => {
      const fsb = path.join(tmpDir, stem + '_b' + i + '.fsb');
      const wav = path.join(tmpDir, stem + '_b' + i + '.wav');
      fs.writeFileSync(fsb, bank);
      execFileSync(VGM, ['-o', wav, fsb], { stdio: 'pipe' });
      return wavStartRms(wav);
    });
    const quietBank = rms[0] <= rms[1] ? 1 : 2;
    // 元数据: intro 的偏移决定 intro 库
    const cab = path.join(tmpDir, stem + '_cab.bin');
    fs.writeFileSync(cab, nodes[cabKey]);
    let introOff = null;
    try {
      const out = execFileSync('python', [CABINFO, cab], { stdio: 'pipe' }).toString();
      const m = out.match(/AudioClip name='.*?_intro'.*?resOffset=(\d+)/);
      if (m) introOff = parseInt(m[1], 10);
    } catch (e) { /* ignore */ }
    const introBank = introOff === 0 ? 1 : (introOff === null ? null : 2);
    const ok = introBank === null || introBank === quietBank;
    if (ok) match++;
    total++;
    console.log((ok ? '✓' : '✗') + ' ' + stem + ' | 库1开头RMS=' + rms[0].toFixed(4) + ' 库2开头RMS=' + rms[1].toFixed(4) + ' | 内容判定:库' + quietBank + '在前 | 元数据intro偏移=' + introOff + ' => intro库' + introBank);
  }
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log('\n对照结果: ' + match + '/' + total + ' 一致');
