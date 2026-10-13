// 校验 WAV：头部字段 + 峰值/RMS（确认非静音）
'use strict';
const fs = require('fs');
const p = process.argv[2];
const b = fs.readFileSync(p);
if (b.toString('latin1', 0, 4) !== 'RIFF') { console.log('不是 RIFF'); process.exit(1); }
const riffSize = b.readUInt32LE(4);
const fmt = b.toString('latin1', 8, 12);
const audioFmt = b.readUInt16LE(20);
const ch = b.readUInt16LE(22);
const rate = b.readUInt32LE(24);
const bits = b.readUInt16LE(34);
console.log('RIFF size:', riffSize, '| fmt:', fmt, '| audioFormat:', audioFmt, '| channels:', ch, '| rate:', rate, '| bits:', bits);
let dataOff = 12;
while (dataOff < b.length) {
  const id = b.toString('latin1', dataOff, dataOff + 4);
  const sz = b.readUInt32LE(dataOff + 4);
  if (id === 'data') break;
  dataOff += 8 + sz + (sz % 2);
}
const dataSize = b.readUInt32LE(dataOff + 4);
console.log('data chunk @', dataOff, 'size:', dataSize);
const samples = dataSize / (ch * bits / 8);
console.log('samples:', samples, '| duration:', (samples / rate).toFixed(2), 's');
// 峰值/RMS
const step = bits / 8;
let peak = 0, sumSq = 0, n = 0;
for (let i = dataOff + 8; i + step <= dataOff + 8 + dataSize; i += step) {
  const s = bits === 16 ? b.readInt16LE(i) : b.readUInt8(i) - 128;
  const v = s / (bits === 16 ? 32768 : 128);
  const a = Math.abs(v);
  if (a > peak) peak = a;
  sumSq += v * v; n++;
}
const rms = Math.sqrt(sumSq / n);
console.log('peak:', peak.toFixed(4), '| RMS:', rms.toFixed(4), '| 有效样本数:', n);
