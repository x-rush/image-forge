---
name: image-forge
description: Multi-provider AI image generation and editing engine (fal.ai + Replicate) — text-to-image, instruction-based editing, background cutout, spend budgeting. Use whenever the user asks to generate, create, draw, or edit an image, or mentions 生图, 画图, 出图, 做图, 配图, 封面, 插画, 头像, 表情包, 概念图, 精修照片, photo retouching — even without saying "generate". Requires FAL_KEY (fal.ai) or REPLICATE_API_TOKEN (Replicate) in the environment; zero dependencies beyond Node >= 18. Routes across Google Nano Banana, xAI Grok, OpenAI GPT-Image, and FLUX models via a JSON model registry — adding a model needs no code changes.
---

# image-forge — Multi-Provider Image Generation Engine

Generate and edit images through pluggable providers (fal.ai, Replicate) using a
zero-dependency Node CLI. Model routing, per-endpoint parameters, and pricing live in
one JSON registry — **adding a model or provider is configuration, not code**.

**Key setup**: set the provider's auth env var (`FAL_KEY` for fal, `REPLICATE_API_TOKEN`
for Replicate — see `providers/replicate.mjs` header for a token-file alternative).
**Never write keys to any file, commit, document, or log.**

Single entry point: host projects should create thin wrappers that forward arguments to
this skill's `scripts/` — never copy the implementation.

When triggered, the system provides a Base directory (referenced as `<skill>` below):

- `<skill>/scripts/gen-image.mjs` — T2I / editing CLI (reads `models.json`, dispatches to providers)
- `<skill>/scripts/cutout.mjs` — solid-background → transparent PNG (JPEG/WebP input needs ffmpeg)
- `<skill>/scripts/budget.mjs` — spend report + monthly budget control
- `<skill>/providers/` — channel implementations (fal = sync REST; replicate = async predictions)
- `<skill>/models.json` — model registry: aliases, endpoints, parameter enums, prices

## Quick Start

```bash
GEN=<skill>/scripts/gen-image.mjs

# Text-to-image (default provider: fal)
node $GEN --model grok2 --prompt "prompt" --size 1024x1024 --out out.png

# Editing (auto-routes to the family's /edit endpoint; minimal request body)
node $GEN --model nb21 --prompt "retouch instructions" --image in.png --out out.png

# Replicate (after configuring REPLICATE_API_TOKEN — see providers/replicate.mjs)
node $GEN --model flux-schnell --prompt "a red apple" --out apple.png

# Cutout / spend / budget
node <skill>/scripts/cutout.mjs --in x.png --out y.png --preview 8bc34a
node $GEN --report && node <skill>/scripts/budget.mjs --check
```

Every successful generation appends to `scripts/gen-log.jsonl` (global ledger).

## Workflow

1. **Budget check**: `budget.mjs --check` before the first generation of a session; report the balance.
2. **Confirm intent** (skip if user already stated all three): ① style ② expected content — include AND exclude ③ count and purpose.
3. **Model selection**: decision tree in `reference/quality-and-budget.md` (photo retouch → nb21; fast/cheap → grok2; heavy text → gpt2; transparent bg → white-bg + cutout).
4. **Prompt assembly**: explicit subject block + style block + composition. Hard verbs for removals ("delete/remove all", never "simplify"), every removal paired with a completion plan, positive phrasing only.
5. **Generate once → visually inspect with Read before delivering.** Retries only after user review; each retry is one prompt → one image → one review.

## Critical Rules

Read `reference/lessons.md` before assembling prompts — every entry was paid for in real spend. Non-negotiables:

- Editing hits the family's `/edit` endpoint only (auto-routed); verify in-place quality with ffmpeg SSIM (>0.9 for retouching; large scene replacements judge per-region instead).
- Enumerate facial flaws explicitly (nasolabial folds / acne / dark circles / redness / stray hairs / oil shine) — "small flaws" gets ignored.
- No negations in prompts; state the positive. Garment descriptions, never ethnicity names.
- Aspect ratio respects EXIF orientation (script handles it).

## Registry & Extending

`models.json` holds all models with provider, endpoints, parameter enums, and official
prices. To add a model: query the catalog → 422-probe the endpoint schema → add a JSON
entry → run one T2I + one edit smoke test. Full guide: `reference/endpoints.md`.
To add a provider: copy `providers/_interface.mjs` contract, implement `generate()`,
register the `auth_env` in `models.json`.

## Boundaries

- Content-production tool only — do not wire keys or provider calls into shipped product code.
- Prefer SVG for small UI icons; generative images for illustration-grade graphics.
- Free knobs first (prompt, local params); bigger models last.
