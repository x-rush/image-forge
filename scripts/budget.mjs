#!/usr/bin/env node
// image-forge 生图预算工具 — 汇总 gen-log.jsonl 账本，管理月预算，查询 fal 真实余额
// 用法：
//   node budget.mjs            # 报表：今日/本月/累计 + 预算状态 + 真实余额
//   node budget.mjs --set 20   # 设月预算 $20（写 budget.json）
//   node budget.mjs --check    # 单行结论（供 agent 会话内快速检查）
//   node budget.mjs --balance  # 只查 fal 控制台真实余额（Account API）
// 零依赖，Node >= 18。数据：脚本旁 gen-log.jsonl（gen-image.mjs 自动记账）与 budget.json。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "gen-log.jsonl");
const CONF = join(HERE, "budget.json");

const usd = (n) => "$" + n.toFixed(2);

function loadEntries() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((e) => e && typeof e.est_usd === "number");
}

function loadBudget() {
  if (!existsSync(CONF)) return null;
  try { return JSON.parse(readFileSync(CONF, "utf8")).monthly_usd ?? null; }
  catch { return null; }
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function isSameLocalMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

// fal Account API 查真实余额（GET /v1/account/billing?expand=credits）
// 认证：Authorization: Key <FAL_ADMIN_KEY 或 FAL_KEY>。⚠️ 该端点需要 Admin 级 key，
// 普通 FAL_KEY 会 403。建议单独设 FAL_ADMIN_KEY 环境变量（仅查余额用）。失败返回 null（不阻塞本地报表）。
async function fetchBalance() {
  const key = process.env.FAL_ADMIN_KEY || process.env.FAL_KEY;
  if (!key) return { err: "FAL_ADMIN_KEY / FAL_KEY 均未设置" };
  try {
    const r = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
      headers: { Authorization: `Key ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { err: `HTTP ${r.status}${r.status === 403 ? "（key 非 Admin 级）" : ""}` };
    const j = await r.json();
    const bal = j?.credits?.current_balance;
    return typeof bal === "number" ? { balance: bal, currency: j.credits.currency || "USD" } : { err: "响应无 credits 字段" };
  } catch (e) {
    return { err: e.name === "TimeoutError" ? "超时" : String(e.message || e) };
  }
}

const args = process.argv.slice(2);
if (args[0] === "--set") {
  const v = Number(args[1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error("用法: budget.mjs --set <正数月预算美元>，例 --set 20");
    process.exit(1);
  }
  writeFileSync(CONF, JSON.stringify({ monthly_usd: v, set_at: new Date().toISOString() }, null, 2));
  console.log(`✅ 月预算已设为 ${usd(v)}（${CONF}）`);
}

const now = new Date();
const entries = loadEntries();
const budget = loadBudget();

const today = entries.filter((e) => isSameLocalDay(new Date(e.ts), now));
const month = entries.filter((e) => isSameLocalMonth(new Date(e.ts), now));
const sum = (arr) => arr.reduce((s, e) => s + e.est_usd, 0);

const todayUsd = sum(today), monthUsd = sum(month), totalUsd = sum(entries);

const bal = await fetchBalance();

if (args[0] === "--balance") {
  if (bal.balance !== undefined) console.log(`fal 真实余额：${usd(bal.balance)} ${bal.currency}`);
  else console.log(`fal 真实余额查询失败：${bal.err}（手动查：https://fal.ai/dashboard/billing）`);
  process.exit(bal.balance !== undefined ? 0 : 1);
}

if (args[0] === "--check") {
  const balTxt = bal.balance !== undefined ? ` · fal余额 ${usd(bal.balance)}` : "";
  if (!budget) { console.log(`[预算] 未设置（本月已用 ${usd(monthUsd)} / ${month.length} 张；累计 ${usd(totalUsd)} / ${entries.length} 张${balTxt}）。设预算：budget.mjs --set <月额度>`); process.exit(0); }
  const pct = (monthUsd / budget) * 100;
  const line = `[预算] 本月 ${usd(monthUsd)} / ${usd(budget)}（${pct.toFixed(0)}%，${month.length} 张）· 今日 ${usd(todayUsd)} · 累计 ${usd(totalUsd)}${balTxt}`;
  if (pct >= 100) { console.log(`⛔ 超支 ` + line + ` ——继续生成须用户明示同意`); process.exit(2); }
  if (pct >= 80) { console.log(`⚠️ 接近上限 ` + line + ` ——生成前提醒用户余量`); process.exit(0); }
  console.log(line); process.exit(0);
}

// 完整报表
const rows = [["模型", "次数", "估算花费"]];
const byModel = {};
for (const e of month) byModel[e.model] = (byModel[e.model] ?? { n: 0, usd: 0 }), byModel[e.model].n++, byModel[e.model].usd += e.est_usd;
for (const [m, v] of Object.entries(byModel)) rows.push([m, String(v.n), usd(v.usd)]);

console.log("══ image-forge 生图预算报表 ══");
console.log(`今日    ：${usd(todayUsd)}（${today.length} 张）`);
console.log(`本月    ：${usd(monthUsd)}（${month.length} 张）`);
console.log(`累计    ：${usd(totalUsd)}（${entries.length} 张）`);
if (rows.length > 1) {
  console.log("本月明细：");
  for (const r of rows.slice(1)) console.log(`  ${r[0].padEnd(8)} ${r[1].padStart(3)} 张  ${r[2]}`);
}
if (budget) {
  const pct = (monthUsd / budget) * 100;
  const remain = Math.max(0, budget - monthUsd);
  console.log(`月预算  ：${usd(budget)} · 已用 ${pct.toFixed(0)}% · 余 ${usd(remain)}`);
  if (pct >= 100) console.log("⛔ 已超支：继续生成须用户明示同意");
  else if (pct >= 80) console.log("⚠️ 已用 ≥80%：每次生成前提醒用户余量");
} else {
  console.log(`月预算  ：未设置（budget.mjs --set <额度美元> 可设置，如 --set 20）`);
}
if (bal.balance !== undefined) {
  console.log(`真实余额：${usd(bal.balance)} ${bal.currency}（fal Account API）`);
  const budgetRemain = budget ? Math.max(0, budget - monthUsd) : Infinity;
  console.log(`实际可用：${usd(Math.min(budgetRemain, bal.balance))} = min(月预算余, 真实余额)`);
  if (bal.balance < 1) console.log("⚠️ 账户余额不足 $1 ——充值：https://fal.ai/dashboard/billing");
} else {
  console.log(`真实余额：查询失败（${bal.err}）— 手动查 https://fal.ai/dashboard/billing`);
}
