#!/usr/bin/env node
/**
 * Provider 接口约定（image-forge 内部文档）
 *
 * 每个 provider 文件必须导出一个 async 函数：
 *
 *   generate({ model, endpoint, isEdit, prompt, imageUris, params, apiKey, onLog }) → { images: [{url?, b64_json?}] }
 *
 * 参数：
 *   model      — models.json 里的别名（如 "nb21"）
 *   endpoint   — 解析后的完整端点/slug（编辑任务已换成 edit_endpoint）
 *   isEdit     — 是否编辑模式
 *   prompt     — 用户提示词
 *   imageUris  — 编辑模式的输入图 data URI 数组
 *   params     — 已按注册表 params 枚举校验过的请求参数（provider 只管通道协议，不管语义）
 *   apiKey     — 该 provider 的 auth_env 环境变量值（gen-image.mjs 读好传入）
 *   onLog(msg) — 进度日志回调（轮询状态等）
 *
 * 返回：{ images } 数组元素含 url 或 b64_json（下载/落盘由 gen-image.mjs 统一处理）
 *
 * 错误：失败时 throw Error（gen-image.mjs 统一捕获、打印、exit 2）。
 * 计费：provider 不记账——gen-image.mjs 按 models.json 单价统一写 gen-log.jsonl。
 *
 * 新增 provider：复制 _template.mjs，实现 generate()，在 models.json providers 段登记 auth_env。
 */
export const PROVIDER_CONTRACT = true;
