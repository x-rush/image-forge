#!/usr/bin/env node
/**
 * image-forge 生图脚本 — 多 provider（fal.ai / Replicate）多模型文生图 / 图生图（编辑）
 *
 * 模型与通道定义在 ../models.json（加模型=改 JSON，不改代码）。
 * provider 实现在 ../providers/*.mjs（fal=同步 REST；replicate=异步预测，token 见该文件头）。
 *
 * 用法:
 *   node tools/gen-image.mjs --model grok --prompt "提示词" --size 1024x1024 --out out.png
 *   node tools/gen-image.mjs --model nb21 --prompt "编辑指令" --image 输入.png --out out.png
 *   node tools/gen-image.mjs --report          （查看生图账单）
 *
 * 模型速查（--model，五模型全端点；传 --image 自动路由该族 /edit；厂商已标注）:
 *   grok2     xAI    Grok Imagine Image 2.0                       写实原地编辑性价比之王
 *   nb21      Google Nano Banana 2.1（2026-10-07 上线）         写实原地编辑 SSIM 最高；插画也行
 *   gpt2      OpenAI GPT Image 2                                 画面含大量文字
 *   flare     OpenAI GPT Image 2.5 Flare                         写实照片精修主力（默认 quality=max）
 *   sunburst  OpenAI GPT Image 2.5 Sunburst                      2.5 质量档（默认 quality=max）
 * openai 系可 --quality auto|low|medium|high|xhigh|max（2.5 全档；gpt2 最高 high）
 *
 * 鉴权: 环境变量 FAL_KEY（Windows 用户级：setx FAL_KEY "..."）
 * 记账: 每次成功生成追加 tools/gen-log.jsonl（估算成本），--report 汇总；实际扣费以 fal 控制台 Billing 页为准。
 * 依赖: 仅 Node 内置 fetch（Node >= 18），无第三方依赖。
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { extname, dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = JSON.parse(readFileSync(join(SKILL_DIR, 'models.json'), 'utf8'));

function loadProvider(name) {
  return import(pathToFileURL(join(SKILL_DIR, 'providers', `${name}.mjs`)).href);
}

function resolveModel(alias, hasImage, providerWanted) {
  const m = REGISTRY.models[alias];
  if (!m) return null;
  const avail = m.availability || {};
  let channels = Object.keys(avail);
  if (providerWanted) {
    if (!avail[providerWanted]) {
      return { alias, error: `模型 ${alias} 在 ${providerWanted} 上不可用（可用通道: ${channels.join(', ') || '无'}）` };
    }
    channels = [providerWanted];
  }
  if (!channels.length) return { alias, error: `模型 ${alias} 无任何可用通道` };
  const ch = channels[0];
  const cfg = avail[ch];
  if (hasImage && !cfg.edit_endpoint && !cfg.edit_via && !cfg.slug) {
    return { alias, error: `模型 ${alias} 在 ${ch} 上无编辑端点` };
  }
  return { ...m, alias, provider: ch, channelCfg: cfg, isEdit: hasImage,
    endpoint: ch === 'fal' ? (hasImage ? cfg.edit_endpoint : cfg.endpoint) : cfg.slug };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const LOG_FILE = new URL('./gen-log.jsonl', import.meta.url);

function usage(msg) {
  if (msg) console.error('错误: ' + msg);
  console.error(`用法:
  node tools/gen-image.mjs --model <grok2|nb21|gpt2|flare|sunburst> --prompt "<提示词>" [选项]
选项（各族支持差异见文件头注释；422 枚举实测于 2026-10-07）:
  --size WxH     生成尺寸，默认 1024x1024（openai 系也可直接传枚举 square|square_hd|portrait_4_3|portrait_16_9|landscape_4_3|landscape_16_9）
  --image 路径   输入图（编辑模式，自动路由该族 /edit 端点）
  --aspect R     直接指定画幅（xai: 16:9 等；google 另有 21:9/4:1/1:4 等）
  --resolution 档  分辨率：xai 1k|2k；google 1K|2K|4K（openai 用 image_size 枚举控制）
  --quality 档   xai: low|medium；gpt2: auto|low|medium|high；2.5: auto|low|medium|high|xhigh|max（默认 max）
  --format F     输出格式 jpeg|png|webp（全族）
  --background B 仅 openai：auto|transparent|opaque（transparent 出透明底）
  --compression N 仅 openai 2.5：输出压缩 0-100
  --seed N       仅 google：复现实验
  --out 路径     输出文件，默认 samples/<时间戳>.png
  --n 数量       生成张数，默认 1
  --report       查看生图账单后退出（不生图）`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { model: null, prompt: null, size: '1024x1024', image: null, out: null, n: 1,
    quality: null, aspect: null, resolution: null, format: null, background: null, compression: null, seed: null,
    given: new Set(), report: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--model') { a.model = argv[++i]; a.given.add('model'); }
    else if (k === '--provider') { a.provider = argv[++i]; a.given.add('provider'); }
    else if (k === '--quality') { a.quality = argv[++i]; a.given.add('quality'); }
    else if (k === '--prompt') a.prompt = argv[++i];
    else if (k === '--size') { a.size = argv[++i]; a.given.add('size'); }
    else if (k === '--aspect') { a.aspect = argv[++i]; a.given.add('aspect'); }
    else if (k === '--resolution') { a.resolution = argv[++i]; a.given.add('resolution'); }
    else if (k === '--format') { a.format = argv[++i]; a.given.add('format'); }
    else if (k === '--background') { a.background = argv[++i]; a.given.add('background'); }
    else if (k === '--compression') { a.compression = parseInt(argv[++i], 10); a.given.add('compression'); }
    else if (k === '--seed') { a.seed = parseInt(argv[++i], 10); a.given.add('seed'); }
    else if (k === '--image') a.image = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--n') a.n = parseInt(argv[++i], 10);
    else if (k === '--report') a.report = true;
    else usage('未知参数 ' + k);
  }
  if (a.report) return a;
  if (!a.model || !REGISTRY.models[a.model]) usage(`--model 必须是 ${Object.keys(REGISTRY.models).join('|')}（见 models.json）`);
  if (!a.prompt) usage('--prompt 必填');
  return a;
}

function toDataUri(p) {
  const abs = resolve(p);
  const mime = MIME[extname(abs).toLowerCase()];
  if (!mime) usage(`不支持的图片格式: ${abs}（支持 png/jpg/webp）`);
  return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
}

// 各族 aspect_ratio 合法枚举（2026-10-07 全端点 422 探测实测；openai 用 image_size 枚举）
const ASPECTS = {
  xai: ['2:1', '20:9', '19.5:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:19.5', '9:20'],
  google: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4'],
};
const OPENAI_SIZES = ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9', 'auto'];

function nearestAspect(r, list) {
  let best = '1:1', diff = Infinity;
  for (const c of list) {
    const [cw, ch] = c.split(':').map(Number);
    const d = Math.abs(cw / ch - r);
    if (d < diff) { diff = d; best = c; }
  }
  return best;
}

function nearestOaiSize(w, h) {
  const r = w / h;
  if (r >= 1.6) return 'landscape_16_9';
  if (r >= 1.15) return 'landscape_4_3';
  if (r > 0.87) return 'square';
  if (r > 0.625) return 'portrait_4_3';
  return 'portrait_16_9';
}

function estUsd(a) {
  const m = REGISTRY.models[a.model] || {};
  const mul = { '2k': 1.4, '2K': 1.5, '4K': 2 }[a.resolution || ''] || 1;
  return Math.round(((m.price_usd || 0.08) * mul + (m.isEdit ? (m.edit_extra_usd || 0) : 0)) * 1000) / 1000;
}
// 读输入图尺寸（PNG 读 IHDR；JPEG 扫 SOF 帧 + EXIF 方向标记 274），编辑模式据此自动下发合法 aspect_ratio。
// ⚠️ ffprobe 的 stream w/h 是物理存储值、不含 EXIF 方向——iPhone 竖拍片存成横幅+rotation 标记，
// 不看 EXIF 会把竖片当横片（2026-10-07 实测踩坑），orientation 5/6/7/8 须交换宽高。
function readExifOrientation(buf) {
  if (buf.readUInt16BE(0) !== 0xffd8) return 1;
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m === 0xe1 && buf.toString('ascii', i + 4, i + 10) === 'Exif\0\0') {
      const tiff = i + 10;
      const little = buf.readUInt16BE(tiff) === 0x4949;
      const rd16 = (p) => buf.readUInt16LE(p) || buf.readUInt16BE(p);
      const u16 = (p) => (little ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
      const u32 = (p) => (little ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
      const ifd = tiff + u32(tiff + 4);
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    if (len < 2) return 1;
    i += 2 + len;
  }
  return 1;
}

function readImageSize(p) {
  const buf = readFileSync(p);
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xc0 || m === 0xc2) {
        let w = buf.readUInt16BE(i + 7), h = buf.readUInt16BE(i + 5);
        const o = readExifOrientation(buf);
        if (o >= 5) [w, h] = [h, w];
        return { w, h };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

function buildParams(a, w, h, m) {
  const cfg = m.channelCfg || {};
  const P = cfg.params || {};
  const style = cfg.param_style || '';
  const want = (k) => a.given.has(k);
  const p = {};

  if (m.isEdit) {
    // 编辑最小体，唯一例外：Replicate nb21 不显式传画幅会用默认值（不跟随输入图）
    if (style === 'replicate-nb21' && P.aspect_ratios?.includes('match_input_image')) {
      p.aspect_ratio = 'match_input_image';
    }
    return p;
  }

  // 画幅：按通道枚举推导
  if (P.aspect_ratios) p.aspect_ratio = (want('aspect') && a.aspect) || nearestAspect(w / h, P.aspect_ratios);
  else if (P.image_sizes) p.image_size = OPENAI_SIZES.includes(a.size) ? a.size : nearestOaiSize(w, h);
  else if (style.startsWith('replicate-openai')) p.aspect_ratio = nearestAspect(w / h, ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']);

  // 分辨率
  if (P.resolutions) p.resolution = (want('resolution') && a.resolution) || P.resolutions[0];
  // 数量
  if (a.n > 1) p.num_images = a.n;
  // 种子（仅注册表声明支持的通道）
  if (P.seed && want('seed')) p.seed = a.seed;
  // 背景（仅声明支持；replicate-openai 枚举里有 transparent）
  if (P.background && want('background')) p.background = a.background;
  if (want('compression')) p.output_compression = a.compression;
  // 格式：通道词表归一（fal 用 jpeg，replicate-openai 用 jpeg/jpeg 均可，nb21 用 jpg）
  if (want('format')) {
    const list = P.output_format || [];
    p.output_format = list.includes(a.format) ? a.format : (list.includes(a.format.replace('jpeg','jpg')) ? a.format.replace('jpeg','jpg') : a.format);
  }
  // 质量档
  if (P.quality && want('quality')) p.quality = a.quality;
  else if (P.default_quality) p.quality = P.default_quality;
  return p;
}

function report() {
  if (!existsSync(LOG_FILE)) { console.log('暂无生图记录（账本 tools/gen-log.jsonl 尚未生成）'); return; }
  const rows = readFileSync(LOG_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let sum = 0;
  for (const r of rows) {
    sum += r.est_usd || 0;
    console.log(
      `${(r.ts || '').slice(0, 16).replace('T', ' ')}  ${String(r.model).padEnd(7)} ${r.size}  ` +
      `${r.secs ?? '-'}s  ${r.kb ?? '-'}KB  $${(r.est_usd ?? 0).toFixed(3)}  ${r.out || ''}${r.note ? '  (' + r.note + ')' : ''}`
    );
  }
  console.log(`—— 共 ${rows.length} 张，估算合计 $${sum.toFixed(2)}（估算参考价；实际以 fal 控制台 Billing 页为准）`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.report) { report(); return; }

  const key = process.env.FAL_KEY;
  if (!key) {
    console.error('错误: 未读到 FAL_KEY。配置: setx FAL_KEY "你的key" 后重开终端。');
    process.exit(1);
  }

  // openai 系 --size 可传枚举（square 等），此时尺寸仅用于记账估算
  const [w, h] = (a.size.includes('x') ? a.size : '1024x1024').split('x').map(Number);
  if (!w || !h) usage(`--size 格式应为 WxH（或 openai 枚举 square/portrait_4_3 等）`);

  const m = resolveModel(a.model, !!a.image, a.provider);
  if (!m) usage(`--model 必须是 ${Object.keys(REGISTRY.models).join('|')}（见 models.json）`);
  if (m.error) { console.error('错误: ' + m.error); process.exit(1); }
  if (a.provider && a.provider !== m.provider) { /* 不可达，resolveModel 已拦截 */ }
  if (a.image) {
    const dim = readImageSize(resolve(a.image));
    if (dim) { a.inW = dim.w; a.inH = dim.h; }
  }
  const params = buildParams(a, w, h, m);
  const provider = await loadProvider(m.provider);
  const authEnv = REGISTRY.providers[m.provider].auth_env;
  const apiKey = process.env[authEnv]
    ?? (m.provider === 'replicate' ? (await loadProvider('replicate')).resolveToken() : undefined);
  const t0 = Date.now();
  let images;
  try {
    const r = await provider.generate({
      model: m.alias, endpoint: m.endpoint, isEdit: m.isEdit,
      prompt: a.prompt, imageUris: m.isEdit ? [toDataUri(a.image)] : [],
      params, apiKey, timeoutMs: 300_000,
    });
    images = r.images;
  } catch (e) {
    console.error(`生成失败（${a.model} / ${m.provider}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    console.error(e.message);
    process.exit(2);
  }

  const img = images[0];

  let bytes;
  const out = a.out || `samples/${Date.now()}.png`;
  if (img.b64_json) bytes = Buffer.from(img.b64_json, 'base64');
  else if (img.url) {
    const r2 = await fetch(img.url, { signal: AbortSignal.timeout(60_000) });
    if (!r2.ok) { console.error(`下载失败 HTTP ${r2.status}`); process.exit(2); }
    bytes = Buffer.from(await r2.arrayBuffer());
  } else { console.error('images[0] 无 url/b64_json: ' + JSON.stringify(img).slice(0, 300)); process.exit(2); }

  mkdirSync(dirname(out), { recursive: true });
  // 按魔数检测真实格式并纠正扩展名（fal 的 Grok 实际回 JPEG，扩展名不可信）
  const sig = bytes.subarray(0, 4).toString('hex');
  const fmt = sig.startsWith('89504e47') ? 'png' : sig.startsWith('ffd8ff') ? 'jpg' : sig.startsWith('52494646') ? 'webp' : null;
  let finalOut = out;
  if (fmt) {
    const wanted = `.${fmt}`;
    if (!finalOut.toLowerCase().endsWith(wanted)) finalOut = finalOut.replace(/\.(png|jpe?g|webp)$/i, '') + wanted;
  }
  writeFileSync(finalOut, bytes);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const est = estUsd(a);
  appendFileSync(LOG_FILE, JSON.stringify({
    ts: new Date().toISOString(), model: a.model, size: `${w}x${h}`,
    secs: +secs, kb: Math.round(bytes.length / 1024), out: finalOut, est_usd: est,
  }) + '\n');
  console.log(`✅ ${a.model} (${m.endpoint} @ ${m.provider}) ${secs}s ${(bytes.length / 1024).toFixed(0)}KB -> ${finalOut}${finalOut !== out ? `（实际格式 ${fmt}，已纠正扩展名）` : ''}`);
  console.log(`   估算 $${est.toFixed(3)}，账单: node tools/gen-image.mjs --report`);
}

main().catch((e) => { console.error('异常: ' + (e?.cause?.message || e.message)); process.exit(3); });
