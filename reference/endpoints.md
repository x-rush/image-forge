# 各端点入参全表（2026-10-07 全端点 422 枚举探测实测）

> 本文件由 SKILL.md 按需引用。CLI 旗标对应：`--size`（WxH 或 openai 枚举）/`--aspect`/`--resolution`/`--quality`/`--format`/`--background`/`--compression`/`--seed`/`--n`。

| 参数 | grok2 (xAI) | nb21 (Google) | gpt2 (OpenAI) | flare/sunburst (OpenAI 2.5) |
| --- | --- | --- | --- | --- |
| `prompt` | ✅必填 | ✅必填 | ✅必填 | ✅必填 |
| `image_urls`（编辑） | ✅ list | ✅ list | ✅ list | ✅ list |
| `aspect_ratio` | ✅ 2:1/20:9/19.5:9/16:9/4:3/3:2/1:1/2:3/3:4/9:16/9:19.5/9:20（edit 另有 auto） | ✅ auto/21:9/16:9/3:2/4:3/5:4/1:1/4:5/3:4/2:3/9:16/4:1/1:4 | ❌ | ❌ |
| `resolution` | ✅ 1k/2k | ✅ 1K/2K/4K | ❌ | ❌ |
| `image_size` | ❌（v2.0 已弃，传了被忽略） | ❌ | ✅ 枚举 square_hd/square/portrait_4_3/portrait_16_9/landscape_4_3/landscape_16_9/auto 或 {width,height} | ✅ 同左 |
| `quality` | ✅ low/medium | ❌ | ✅ auto/low/medium/high | ✅ auto/low/medium/high/xhigh/max |
| `num_images` | ✅ | ✅ | ✅ | ✅ |
| `seed` | ❌ | ✅ | ❌ | ❌ |
| `background` | ❌ | ❌ | ❌（实测 422 不支持 transparent） | ✅ auto/transparent/opaque |
| `output_format` | ✅ jpeg/png/webp | ✅ | ✅ | ✅ |
| `output_compression` | ❌ | ❌ | ❌ | ✅ int |

## 新模型接入流程（15 分钟）

1. 查目录：`curl -s "https://fal.ai/api/models?keywords=<模型名>"` —— 看 id、category、modelLab（厂商）、pricingInfoOverride（官方价）
2. 探端点：对 `{t2i-id}` 和 `{t2i-id}/edit` 各发一次空/非法 body 的 POST（422 回显=在线+拿到必填字段与枚举），免费不扣费
3. 注册：SKILL.md 模型矩阵加一行 + gen-image.mjs `MODEL_IDS` 加别名 + `EDIT_MAP` 加编辑路由（若该族有 /edit）
4. 校准：`estUsd` 的 BASE 表加官方单价
5. 实测：文生图 1 张 + 编辑 1 张（ffmpeg SSIM 验证是否原地），记录实测列

## 探测方法论（可复用）

对端点 POST 一条含**保证非法的锚字段**（如 `quality:"bogus"`）+ 全部候选字段的 body——FastAPI 的 422 会一次回显所有字段的类型错误与合法枚举，免费拿到完整参数表，且不会真执行。fal 控制台会留下零星 Failed 记录，无害。

## 定价校准

fal 定价页和目录 `pricing` 字段常为空——**看目录接口的 `pricingInfoOverride` 字段**（文本描述，含单价/倍率规则）。估价会过期，定期对控制台 Billing 校准。
