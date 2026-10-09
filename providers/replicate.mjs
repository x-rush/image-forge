#!/usr/bin/env node
/**
 * Replicate provider — 异步预测式 API
 *
 * ═══════════════ REPLICATE_API_TOKEN 配置入口（三选一，优先级从高到低）═══════════════
 *  1. 环境变量（推荐）：
 *       setx REPLICATE_API_TOKEN "r8_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"     （Windows 用户级）
 *       export REPLICATE_API_TOKEN="r8_xxx"                             （macOS/Linux）
 *  2. Token 文件（不想进环境变量时）：
 *       在本文件同级创建 token.txt，第一行放 token，即可被自动读取。
 *       ⚠️ token.txt 已列入 .gitignore，永不提交；文件权限仅本人可读。
 *  3. 获取 token：https://replicate.com/account/api-tokens → "Create token"（r8_ 开头）
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * API 形态（与 fal 的同步 REST 不同）：
 *   POST https://api.replicate.com/v1/models/<owner>/<name>/predictions  → { id }
 *   GET  https://api.replicate.com/v1/predictions/<id>                   → { status, output }
 *   status: starting → processing → succeeded / failed / canceled
 *   鉴权 Header: Authorization: "Bearer <token>"（注意与 fal 的 "Key" 前缀不同）
 *
 * 参数差异（相对 fal）：无 aspect_ratio 的"19.5:9"类极端档；num_images 叫 num_outputs；
 *   输入图字段叫 image（单数，string URL/dataURI）。模型实际 schema 以
 *   https://replicate.com/<owner>/<name>/api/schema 为准，首跑前建议先看一眼。
 *
 * ⚠️ 状态：代码按官方文档实现，尚无真实 token 实测（标注 UNTESTED）。
 *    首次使用请先用便宜模型（flux-schnell $0.003）跑一张验证通路。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveToken() {
  // 1) 环境变量优先
  if (process.env.REPLICATE_API_TOKEN) return process.env.REPLICATE_API_TOKEN;
  // 2) 同目录 token.txt（不进 git）
  const tokenFile = join(dirname(fileURLToPath(import.meta.url)), 'token.txt');
  if (existsSync(tokenFile)) {
    const t = readFileSync(tokenFile, 'utf8').trim().split('\n')[0].trim();
    if (t) return t;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function generate({ endpoint, isEdit, prompt, imageUris, params, apiKey, timeoutMs = 300000, onLog = () => {} }) {
  if (!apiKey) {
    throw new Error(
      '未找到 REPLICATE_API_TOKEN。配置方式（三选一）：\n' +
      '  1. setx REPLICATE_API_TOKEN "r8_xxx"（Windows 用户级，重开终端生效）\n' +
      '  2. 在 providers/ 目录下创建 token.txt，第一行放 token\n' +
      '  3. 到 https://replicate.com/account/api-tokens 创建（r8_ 开头）'
    );
  }

  // Replicate 输入映射（与 fal 的差异集中在这里）
  const input = { prompt };
  if (params.output_format) input.output_format = params.output_format;
  if (params.aspect_ratio) input.aspect_ratio = params.aspect_ratio;
  if (params.num_images > 1) input.num_outputs = params.num_images;
  if (params.seed != null) input.seed = params.seed;
  if (isEdit) {
    if (!imageUris?.length) throw new Error('编辑模式需要输入图');
    input.image = imageUris[0]; // Replicate 用单数字段（kontext 系）
  }

  // 创建 prediction（官方推荐走 models 端点，自动指向最新版本）
  const createRes = await fetch(`https://api.replicate.com/v1/models/${endpoint}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!createRes.ok) {
    throw new Error(`Replicate 创建预测失败 HTTP ${createRes.status}: ${(await createRes.text()).slice(0, 500)}`);
  }
  let pred = await createRes.json();

  // Prefer: wait 最多挂 ~60s；未完成则轮询
  const deadline = Date.now() + timeoutMs;
  while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
    if (Date.now() > deadline) throw new Error(`Replicate 轮询超时（${timeoutMs / 1000}s），prediction ${pred.id}`);
    onLog(`  replicate ${pred.status}...`);
    await sleep(2000);
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!poll.ok) throw new Error(`Replicate 轮询失败 HTTP ${poll.status}`);
    pred = await poll.json();
  }
  if (pred.status !== 'succeeded') {
    throw new Error(`Replicate 预测 ${pred.status}: ${(pred.error || '无错误详情').toString().slice(0, 400)}`);
  }

  // output 兼容三种形态：string / string[] / {images:[...]}
  const out = pred.output;
  let urls = Array.isArray(out) ? out : typeof out === 'string' ? [out] : out?.images?.map((i) => (typeof i === 'string' ? i : i.url)) || [];
  if (!urls.length) throw new Error(`Replicate output 无可用图片 URL: ${JSON.stringify(out).slice(0, 300)}`);
  // gen-image.mjs 统一按 url 下载落盘；b64_json 形态 Replicate 不使用
  return { images: urls.map((u) => ({ url: u })) };
}
