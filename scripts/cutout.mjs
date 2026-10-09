#!/usr/bin/env node
/**
 * 纯 Node 抠图工具 — 白/纯色底生图 → 透明底 PNG（零依赖）
 *
 * 用法:
 *   node tools/cutout.mjs --in 输入.png --out 输出.png [--size 720] [--tol 22] [--preview 8bc34a]
 *
 * 原理: 取四角中值色当背景色 → 从画面边缘 BFS 泛洪（只沿"接近背景色"的连通区扩散，
 *       主体内部的浅色不会被误删）→ 泛洪边界按色距给软 alpha → 面积平均缩放到目标尺寸。
 * 选项:
 *   --size W      输出尺寸（等比缩放，默认 720）
 *   --tol N       背景判定容差 0-255（默认 22，边缘留白圈加大、误删主体则减小）
 *   --preview 色  额外输出一张合成到纯色底的预览 PNG（检查边缘用），色值如 8bc34a
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

// ---------- 输入加载（PNG 直接解；JPEG/WebP 借 ffmpeg 转临时 PNG，机器需装 ffmpeg） ----------
function decodeAny(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) === 0x89504e47) return decodePNG(buf);
  const tmp = mkdtempSync(join(tmpdir(), 'cutout-')) + '/in.png';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', resolve(path), tmp]);
  return decodePNG(readFileSync(tmp));
}

// ---------- PNG 解码（支持 8bit RGB/RGBA，非隔行） ----------
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG（decodeAny 应已转码）');
  let pos = 8; const idat = []; let ihdr = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0)
    throw new Error(`不支持的 PNG: depth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * bpp;
      out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2];
      out[o + 3] = colorType === 6 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

// ---------- PNG 编码（RGBA，filter 0） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 抠图：边缘泛洪 + 软边 ----------
function cutout(img, tol) {
  const { width: W, height: H, data } = img;
  // 背景色 = 四角 5x5 区域的中值估计
  const corners = [[0, 0], [W - 5, 0], [0, H - 5], [W - 5, H - 5]];
  let br = 0, bg = 0, bb = 0, n = 0;
  for (const [cx, cy] of corners)
    for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) {
      const o = ((cy + dy) * W + (cx + dx)) * 4;
      br += data[o]; bg += data[o + 1]; bb += data[o + 2]; n++;
    }
  br = Math.round(br / n); bg = Math.round(bg / n); bb = Math.round(bb / n);

  const alpha = new Uint8Array(W * H).fill(255);
  const visited = new Uint8Array(W * H);
  const queue = [];
  const pushIfBg = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = y * W + x;
    if (visited[p]) return;
    const o = p * 4;
    const d = Math.max(Math.abs(data[o] - br), Math.abs(data[o + 1] - bg), Math.abs(data[o + 2] - bb));
    if (d <= tol * 1.6) { visited[p] = 1; queue.push(p); alpha[p] = d <= tol ? 0 : Math.round(((d - tol) / (tol * 0.6)) * 255); }
  };
  for (let x = 0; x < W; x++) { pushIfBg(x, 0); pushIfBg(x, H - 1); }
  for (let y = 0; y < H; y++) { pushIfBg(0, y); pushIfBg(W - 1, y); }
  while (queue.length) {
    const p = queue.pop();
    const x = p % W, y = (p / W) | 0;
    pushIfBg(x - 1, y); pushIfBg(x + 1, y); pushIfBg(x, y - 1); pushIfBg(x, y + 1);
  }
  // 已有输入透明通道的保留
  return { width: W, height: H, data, alpha, bg: [br, bg, bb] };
}

// ---------- 面积平均缩放 ----------
function resize(img, alpha, size) {
  const { width: W, height: H, data } = img;
  const out = Buffer.alloc(size * size * 4);
  const rx = W / size, ry = H / size;
  for (let y = 0; y < size; y++) {
    const sy0 = Math.floor(y * ry), sy1 = Math.min(H, Math.max(sy0 + 1, Math.ceil((y + 1) * ry)));
    for (let x = 0; x < size; x++) {
      const sx0 = Math.floor(x * rx), sx1 = Math.min(W, Math.max(sx0 + 1, Math.ceil((x + 1) * rx)));
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const o = (sy * W + sx) * 4, al = alpha[sy * W + sx];
        const af = al / 255;
        r += data[o] * af; g += data[o + 1] * af; b += data[o + 2] * af; a += al; cnt++;
      }
      const o2 = (y * size + x) * 4;
      const aa = a / cnt;
      out[o2] = aa > 0 ? Math.round(r / (a / 255)) : 0;
      out[o2 + 1] = aa > 0 ? Math.round(g / (a / 255)) : 0;
      out[o2 + 2] = aa > 0 ? Math.round(b / (a / 255)) : 0;
      out[o2 + 3] = Math.round(aa);
    }
  }
  return { width: size, height: size, data: out };
}

// ---------- 主流程 ----------
function arg(k, d) { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; }
const inPath = arg('--in'), outPath = arg('--out');
if (!inPath || !outPath) { console.error('用法: node tools/cutout.mjs --in x.png --out y.png [--size 720] [--tol 22] [--preview 8bc34a]'); process.exit(1); }
const size = parseInt(arg('--size', '720'), 10);
const tol = parseFloat(arg('--tol', '22'));
const preview = arg('--preview', null);

const t0 = Date.now();
let img = decodeAny(inPath);
const cropArg = arg('--crop', null);
if (cropArg) {
  const [cl, ct, cw, ch] = cropArg.split(',').map(Number);
  const { width: W, data } = img;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const so = ((ct + y) * W + (cl + x)) * 4, d = (y * cw + x) * 4;
    out[d] = data[so]; out[d + 1] = data[so + 1]; out[d + 2] = data[so + 2]; out[d + 3] = data[so + 3];
  }
  img = { width: cw, height: ch, data: out };
  console.log(`   裁切: left=${cl} top=${ct} ${cw}x${ch}（原图 ${W}x${img.height + ct}）`);
}
const cut = cutout(img, tol);
let cutCount = 0;
for (let i = 0; i < cut.alpha.length; i++) if (cut.alpha[i] < 128) cutCount++;
const final = resize(img, cut.alpha, size);
writeFileSync(outPath, encodePNG(final.width, final.height, final.data));

console.log(`✅ ${inPath} -> ${outPath}`);
console.log(`   背景 RGB(${cut.bg.join(',')}) 容差 ${tol}，去底 ${(100 * cutCount / (img.width * img.height)).toFixed(1)}%，${size}x${size}，${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (preview) {
  const pv = Buffer.from(final.data); // copy
  const hex = preview.replace('#', '');
  const pr = parseInt(hex.slice(0, 2), 16), pg = parseInt(hex.slice(2, 4), 16), pb = parseInt(hex.slice(4, 6), 16);
  for (let i = 0; i < pv.length; i += 4) {
    const a = pv[i + 3] / 255;
    pv[i] = Math.round(pv[i] * a + pr * (1 - a));
    pv[i + 1] = Math.round(pv[i + 1] * a + pg * (1 - a));
    pv[i + 2] = Math.round(pv[i + 2] * a + pb * (1 - a));
    pv[i + 3] = 255;
  }
  const pOut = outPath.replace(/\.png$/, '') + '.preview.png';
  writeFileSync(pOut, encodePNG(final.width, final.height, pv));
  console.log(`   预览(合成 #${hex} 底): ${pOut}`);
}
