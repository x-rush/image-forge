#!/usr/bin/env node
/**
 * fal.ai provider — 队列异步（POST queue.fal.run/<endpoint> → 5s 轮询 → 取结果）
 *
 * 要点（2026-10-10 统一异步化，勿改回同步长连接）：
 *  - 同步 fal.run 长连接在代理环境易被掐断且中断后不可恢复（无任务 id）——队列模式
 *    提交即得 request_id，中断后 --resume 凭 id 重取（服务端托管任务，不重复扣费）
 *  - 队列对图片模型同样有效（实测 2026-10-10：提交即入队；校验在 worker 层，422 拒绝不扣费）
 *  - 轮询 GET status_url（5s 间隔，瞬时错误自动重试 3 次）；COMPLETED 后 GET response_url
 *  - 队列命名空间 = 端点前两段（owner/model），resume 用（与 video-forge 同规则）
 *  - 鉴权 Header: Authorization: "Key <FAL_KEY>"（不是 Bearer）
 *  - 编辑任务只发 prompt + image_urls（数组），多余参数会触发整幅重绘（勿改回）
 *  - openai 系 quality 档在编辑模式下也允许（计费/质量参数，不影响构图）
 */
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

function readableError(head, j, text) {
  const d = j?.detail;
  const detail = Array.isArray(d)
    ? d.map((x) => `- [${(x.loc || []).join(".")}] ${x.msg}${x.ctx?.expected ? `（应为 ${x.ctx.expected}）` : ""}`).join("\n")
    : String(d ?? text.slice(0, 400));
  return `${head}\n${detail}`;
}

// 提交后通用的"轮询到完成 → 取响应体"流程；resume 复用
async function pollUntilDone({ status_url, response_url, apiKey, timeoutMs, onLog }) {
  const deadline = Date.now() + timeoutMs;
  let st = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(status_url, { headers: { Authorization: `Key ${apiKey}` }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        st = await r.json();
        break;
      } catch (e) {
        if (attempt >= 3) throw new Error(`轮询连续失败 3 次：${e.message}`);
        onLog(`⚠️ 轮询瞬时错误（${attempt}/3）: ${e.message}，5s 后重试`);
        await new Promise((r2) => setTimeout(r2, 5000));
      }
    }
    if (st.status === "COMPLETED") break;
    onLog(`… ${st.status}${st.queue_position != null ? `（队列第 ${st.queue_position} 位）` : ""}`);
  }
  if (!st || st.status !== "COMPLETED") throw new Error(`轮询超时（${Math.round(timeoutMs / 1000)}s）`);
  const rr = await fetch(response_url, { headers: { Authorization: `Key ${apiKey}` }, signal: AbortSignal.timeout(30000) });
  const rt = await rr.text();
  if (!rr.ok) {
    const e = new Error(readableError(`fal 任务失败 HTTP ${rr.status}`, safeJson(rt), rt));
    if (rr.status === 422) e.validation = true; // worker 校验拒绝（未扣费）
    throw e;
  }
  return safeJson(rt);
}

function parseImages(j) {
  if (!j?.images?.length) throw new Error(`fal 响应无 images 字段: ${JSON.stringify(j).slice(0, 300)}`);
  return j.images;
}

export async function generate({ endpoint, isEdit, prompt, imageUris, params, apiKey, onLog = () => {}, timeoutMs = 600000 }) {
  const body = { prompt };
  if (isEdit) {
    body.image_urls = imageUris;
  } else {
    Object.assign(body, params);
  }
  if (params.quality && endpoint.startsWith('openai/')) body.quality = params.quality;

  const res = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const submit = safeJson(text);
  if (!res.ok) throw new Error(readableError(`fal 提交 HTTP ${res.status}`, submit, text));
  const { request_id, status_url, response_url } = submit ?? {};
  if (!request_id || !status_url || !response_url) throw new Error(`fal 提交响应缺字段: ${text.slice(0, 300)}`);
  onLog(`request_id=${request_id}，每 5s 轮询…`);

  const j = await pollUntilDone({ status_url, response_url, apiKey, timeoutMs, onLog });
  return { images: parseImages(j), request_id };
}

// 中断恢复：凭 request_id 重取（服务端任务不重复扣费）。未完成则继续轮询至完成
export async function resume({ request_id, endpoint, apiKey, onLog = () => {}, timeoutMs = 600000 }) {
  const ns = endpoint.split("/").slice(0, 2).join("/");
  const base = `https://queue.fal.run/${ns}/requests/${encodeURIComponent(request_id)}`;
  onLog(`♻️ 重取 fal request ${request_id}`);
  const s = await fetch(`${base}/status`, { headers: { Authorization: `Key ${apiKey}` }, signal: AbortSignal.timeout(15000) });
  if (s.status === 404) throw new Error(`request 不存在：${request_id}`);
  if (!s.ok) throw new Error(`fal 状态查询 HTTP ${s.status}`);
  const j = await s.json();
  if (j.status !== "COMPLETED") onLog(`… ${j.status}，继续轮询至完成`);
  const out = await pollUntilDone({ status_url: `${base}/status`, response_url: base, apiKey, timeoutMs, onLog });
  return { images: parseImages(out), request_id };
}
