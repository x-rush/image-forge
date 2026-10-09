# image-forge

Multi-provider AI image generation & editing engine for AI coding agents (Claude Code, ZCode, and other SKILL.md-compatible agents). One CLI across **fal.ai** and **Replicate**, routing Google Nano Banana, xAI Grok, OpenAI GPT-Image, and FLUX models through a JSON model registry — adding a model or provider is configuration, not code.

## Why

Most image-gen wrappers hardcode one gateway and one model list. That breaks twice: gateways have different API shapes (fal = sync REST; Replicate = async predictions), and model catalogs change weekly (new model drops, endpoint splits, deprecated params). image-forge separates:

- **providers/** — channel protocol only (auth header, request shape, polling)
- **models.json** — model registry: alias → endpoints, parameter enums, official prices
- **SKILL.md** — orchestration: budget check → intent confirm → model selection → prompt assembly → generate-once → visual inspection

Hard-won operational knowledge is captured in `reference/`: a per-endpoint parameter matrix probed via 422 error-reflection, prompt rules bought with real spend (negations invite split-panels; soft verbs get ignored; facial flaws must be enumerated), EXIF-aware aspect handling, and ffmpeg SSIM discipline to distinguish in-place retouching from silent repaints.

## Models (fal.ai, verified)

| Alias | Vendor | Model | Best for | Price (USD/img) |
| --- | --- | --- | --- | --- |
| `nb21` | Google | Nano Banana 2.1 | Photo retouching / in-place editing (SSIM 0.97) | $0.08 |
| `grok2` | xAI | Grok Imagine Image 2.0 | Fast iteration, T2I workhorse | $0.04–0.06 |
| `gpt2` | OpenAI | GPT Image 2 | Images with heavy text | ≈$0.16 |
| `flare` / `sunburst` | OpenAI | GPT Image 2.5 | Premium edits / quality tier | ≈$0.16 |

## Models (Replicate, UNTESTED — configure token first)

| Alias | Vendor | Model | Best for | Price (USD/img) |
| --- | --- | --- | --- | --- |
| `flux-schnell` | BFL | FLUX.1 schnell | Fastest T2I (~1s) | ≈$0.003 |
| `flux-dev` | BFL | FLUX.1 dev (+kontext edit) | Higher-quality T2I + editing | ≈$0.025 |

## Setup

```bash
git clone https://github.com/x-rush/image-forge ~/.agents/skills/image-forge

# Provider auth — pick one or both:
export FAL_KEY="..."                          # https://fal.ai/dashboard/keys
export REPLICATE_API_TOKEN="r8_..."           # https://replicate.com/account/api-tokens
# Replicate alternative (file-based, gitignored):
#   echo "r8_..." > ~/.agents/skills/image-forge/providers/token.txt

node ~/.agents/skills/image-forge/scripts/budget.mjs --set 10   # optional monthly budget
```

Requires Node >= 18. Optional: `ffmpeg` on PATH.

## Usage

```bash
GEN=~/.agents/skills/image-forge/scripts/gen-image.mjs

node $GEN --model grok2 --prompt "a cat on a windowsill" --size 1024x1024 --out cat.png
node $GEN --model nb21 --prompt "remove the crowd, keep her pose" --image photo.jpg --out retouched.png
node $GEN --model flux-schnell --prompt "a red apple" --out apple.png        # Replicate
node $GEN --report
node ~/.agents/skills/image-forge/scripts/budget.mjs --check
```

## Extension guide

- **Add a model**: query the gateway catalog → probe the endpoint schema with an intentionally-invalid request (422 reflection reveals the full schema for free) → add a JSON entry to `models.json` → run one T2I + one edit smoke test. See `reference/endpoints.md`.
- **Add a provider**: implement `generate()` per the contract in `providers/_interface.mjs`, register its `auth_env` in `models.json`.

## Companion skill

**[photo-retouch](https://github.com/x-rush/photo-retouch)** — a portrait-retouching methodology pack built on image-forge: exhaustive pre-flight analysis worksheet, single-shot generation discipline, an 8-point identity-anchor checklist, and an element keep/remove judgment framework.

## License

MIT
