# image-forge

Multi-provider AI image generation & editing engine for AI coding agents (Claude Code, ZCode, and other SKILL.md-compatible agents). One CLI across **fal.ai** and **Replicate**, routing five flagship models — Google Nano Banana 2.1, xAI Grok Imagine, OpenAI GPT-Image 2 / 2.5 (Flare & Sunburst) — through a JSON model registry: **adding a model or provider is configuration, not code**.

## Why

Most image-gen wrappers hardcode one gateway and one model list. That breaks twice: gateways have different API shapes (fal = sync REST; Replicate = async predictions), and model catalogs change weekly (new model drops, endpoint splits, deprecated params). image-forge separates:

- **providers/** — channel protocol only (auth header, request shape, polling)
- **models.json** — model registry: alias → endpoints, per-channel parameter enums (probed from live schemas), verified prices
- **SKILL.md** — orchestration: budget check → intent confirm → model selection → prompt assembly → generate-once → visual inspection

## Models (all verified on both channels, 2026-10)

| Alias | Vendor | Model | Best for | fal price |
| --- | --- | --- | --- | --- |
| `nb21` | Google | Nano Banana 2.1 | Photo retouching / in-place editing — **edit SSIM 0.975, highest** | $0.08 |
| `grok2` | xAI | Grok Imagine Image | Fast iteration (13-16s) — **edit on Replicate (0.951) beats fal (0.746)** | $0.04–0.06 |
| `gpt2` | OpenAI | GPT Image 2 | Images with heavy text (editing = full repaint on both channels) | ≈$0.16 |
| `flare` | OpenAI | GPT Image 2.5 Flare | Premium edits (SSIM 0.919) | ≈$0.16 |
| `sunburst` | OpenAI | GPT Image 2.5 Sunburst | 2.5 quality tier (**edit SSIM 0.969, 2nd best**) | ≈$0.16 |

Replicate billing is GPU-time based (no public per-image price); official-reference benchmarks are recorded per model in `models.json`.

**Key finding from our 21-image verification matrix**: the same model can edit very differently across channels (grok2: Replicate 0.951 vs fal 0.746). The registry records `edit_ssim_verified` and `best_edit_channel` per model so the agent picks the right channel automatically.

## Install

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
GEN=~/.agents/skills/image-forge/scripts/gen-image.js

node $GEN --model grok2 --prompt "a cat on a windowsill" --size 1024x1024 --out cat.png
node $GEN --model nb21 --prompt "remove the crowd, keep her pose" --image photo.jpg --out retouched.png
node $GEN --model nb21 --provider replicate --prompt "..." --out alt.png   # explicit channel
node $GEN --intent --describe "客户头像精修"    # decision support: dumps registry + enums
node $GEN --report && node ~/.agents/skills/image-forge/scripts/budget.mjs --check
```

All flags: `--model --provider --prompt --size --aspect --resolution --quality --format --background --compression --seed --image --out --n --intent --describe --report`.

## What makes this skill different

- **Verified parameter matrix** — every endpoint's schema probed via 422 error-reflection (free), not guessed from docs
- **Auto edit-routing** — gateways split edit models into separate `/edit` endpoints; the legacy unified endpoints silently *ignore* input images and hallucinate strangers. EDIT_MAP handles all routing
- **Cross-channel SSIM discipline** — in-place retouching is verified with ffmpeg SSIM per channel/model; "same model" does not mean "same edit behavior" across gateways
- **Hard-won prompt rules** — negation phrasing invites split-panels; soft verbs get ignored; facial flaws must be enumerated. All captured in `reference/lessons.md`
- **EXIF-aware aspect ratio** — iPhone portraits are stored landscape+rotation; the script reads orientation so edits never get the wrong canvas
- **Spend ledger + budget guardrails** — per-generation cost logging, monthly budget with hard-stop behavior
- **--intent decision mode** — dumps the full registry + enums for the agent to derive best parameters from user requirements

## Structure

```
image-forge/
├── SKILL.md                      # Entry point (loaded when triggered)
├── models.json                   # Model registry (models x channels x params x prices)
├── providers/                    # Channel implementations (fal / replicate / contract)
├── reference/
│   ├── decision-tree.md          # Requirement → params mapping rules
│   ├── endpoints.md              # Per-endpoint parameter matrix + onboarding guide
│   ├── lessons.md                # Paid-for lessons: prompt/edit/channel pitfalls
│   └── quality-and-budget.md     # Validation checklist + cost decision tree
└── scripts/
    ├── gen-image.js              # T2I / editing CLI (zero deps)
    ├── cutout.js                 # Flood-fill cutout (zero deps)
    └── budget.mjs                # Spend report / budget control
```

## Companion skill

**[photo-retouch](https://github.com/x-rush/photo-retouch)** — portrait-retouching methodology pack built on image-forge: exhaustive pre-flight worksheet, three edit classes (correction / re-imagination / expansion), 8-point identity-anchor checklist, professional color-grading playbook, and an element keep/remove judgment framework.

## Notes

- Prices are estimates logged per generation; gateway billing pages are authoritative.
- `background: transparent` is supported by GPT-Image-2.5 endpoints only; GPT-Image-2 rejects it (verified). The universal route is white-background generation + `cutout.js`.
- Key security: `FAL_KEY` / `REPLICATE_API_TOKEN` live only in environment variables. If leaked, rotate at the provider console.

## License

MIT
