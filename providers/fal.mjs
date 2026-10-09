#!/usr/bin/env node
/**
 * fal.ai provider — 同步 REST（POST fal.run/<endpoint>，等待即返回结果）
 *
 * 要点（实测沉淀，勿改回）：
 *  - 编辑任务只发 prompt + image_urls（数组），多余参数会触发整幅重绘
 *  - fal 各族 /edit 端点与文生图端点是分开的，路由由 gen-image.mjs 按 models.json 处理
 *  - 鉴权 Header: Authorization: "Key <FAL_KEY>"
 */
export async function generate({ endpoint, isEdit, prompt, imageUris, params, apiKey, timeoutMs = 300000 }) {
  const body = { prompt };
  if (isEdit) {
    body.image_urls = imageUris;
  } else {
    Object.assign(body, params);
  }
  // openai 系质量档在编辑模式下也允许（是计费/质量参数，不影响构图）
  if (params.quality && endpoint.startsWith('openai/')) body.quality = params.quality;

  const res = await fetch(`https://fal.run/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 800);
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j.detail)) detail = j.detail.map((d) => `- [${(d.loc || []).join('.')}] ${d.msg}`).join('\n');
    } catch {}
    throw new Error(`fal HTTP ${res.status}\n${detail}`);
  }

  const j = JSON.parse(text);
  if (!j.images?.length) throw new Error(`fal 响应无 images 字段: ${text.slice(0, 300)}`);
  return { images: j.images };
}
