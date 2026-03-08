# [1.3.0](https://github.com/terrylica/nanoclaw/compare/v1.2.0...v1.3.0) (2026-03-08)


### Bug Fixes

* add-voice-transcription skill drops WhatsApp registerChannel call ([#766](https://github.com/terrylica/nanoclaw/issues/766)) ([47ad2e6](https://github.com/terrylica/nanoclaw/commit/47ad2e654c7aeb408e5a5fcb24ffb2a9d83df3c3))
* aggressive false positive prevention — 5-layer MiniMax pipeline, devil's advocate round, FP learning ([8bfa372](https://github.com/terrylica/nanoclaw/commit/8bfa372b967a9ef19765392769cf71ccff54a560))
* atomic claim prevents scheduled tasks from executing twice ([#657](https://github.com/terrylica/nanoclaw/issues/657)) ([f794185](https://github.com/terrylica/nanoclaw/commit/f794185c21de12cc89bd8fda35e0e2eb1c120fda)), closes [#138](https://github.com/terrylica/nanoclaw/issues/138) [#138](https://github.com/terrylica/nanoclaw/issues/138) [#211](https://github.com/terrylica/nanoclaw/issues/211) [#300](https://github.com/terrylica/nanoclaw/issues/300) [#578](https://github.com/terrylica/nanoclaw/issues/578) [#601](https://github.com/terrylica/nanoclaw/issues/601) [#138](https://github.com/terrylica/nanoclaw/issues/138) [#300](https://github.com/terrylica/nanoclaw/issues/300) [#138](https://github.com/terrylica/nanoclaw/issues/138)
* cc-skills now reads label strategy + content types; Claude JSON parsing hardened ([fd7fc7f](https://github.com/terrylica/nanoclaw/commit/fd7fc7f0c965ea5adcecf66240a65544647cc368))
* correct misleading send_message tool description for scheduled tasks ([#729](https://github.com/terrylica/nanoclaw/issues/729)) ([ec0e42b](https://github.com/terrylica/nanoclaw/commit/ec0e42b03413d7b8af7daa61f0e200fb7dd106a1))
* **db:** add LIMIT to unbounded message history queries ([#692](https://github.com/terrylica/nanoclaw/issues/692)) ([#735](https://github.com/terrylica/nanoclaw/issues/735)) ([74b02c8](https://github.com/terrylica/nanoclaw/commit/74b02c87159f3b27ed11d07573d4ca2fb283ea12))
* format src/index.ts to pass CI prettier check ([#711](https://github.com/terrylica/nanoclaw/issues/711)) ([df2bac6](https://github.com/terrylica/nanoclaw/commit/df2bac61f0b3b468ea68e9c279461eea942bbdf9)), closes [#710](https://github.com/terrylica/nanoclaw/issues/710)
* grant write permissions to CLAUDE.md maintenance claude -p call ([9ddb433](https://github.com/terrylica/nanoclaw/commit/9ddb433d7ed4e4a11ffa7283826126b63ea5f006))
* rename _chatJid to chatJid in onMessage callback ([1436186](https://github.com/terrylica/nanoclaw/commit/1436186c75dd9cd6c85d60ad359e520ee06c630d))
* use 'state' instead of 'stateReason' for gh compatibility on bigblack ([a4f2e92](https://github.com/terrylica/nanoclaw/commit/a4f2e92b29d3a48ac3f8da1010cb459b067a0aee))
* **whatsapp:** add error handling to messages.upsert handler ([#695](https://github.com/terrylica/nanoclaw/issues/695)) ([5e3d8b6](https://github.com/terrylica/nanoclaw/commit/5e3d8b6c2c3b6976da6015fe8d8f07aa5e9113ff))
* **whatsapp:** write pairing code to file for immediate access ([#745](https://github.com/terrylica/nanoclaw/issues/745)) ([be19911](https://github.com/terrylica/nanoclaw/commit/be1991108b213b8b79c9e093d7727aee3a5342e8))


### Features

* add /add-ollama skill for local model inference ([#712](https://github.com/terrylica/nanoclaw/issues/712)) ([298c3ea](https://github.com/terrylica/nanoclaw/commit/298c3eade4a8497264844aa29e71bee7dadf3a89))
* add ast-grep rules for Python static analysis ([a548761](https://github.com/terrylica/nanoclaw/commit/a548761075370df0dc679eec22cd22cd0b65217a))
* add mise deploy task for bigblack deployment ([c39a1f4](https://github.com/terrylica/nanoclaw/commit/c39a1f4e603f4d10a5752759c400942d8856be5b))
* add NDJSON telemetry logging for all Telegram messages ([7f64ea6](https://github.com/terrylica/nanoclaw/commit/7f64ea630399bfcc3e7e3126db8822b79241f694))
* add update_task tool and return task ID from schedule_task ([68123fd](https://github.com/terrylica/nanoclaw/commit/68123fdd81c259f3379c21bd9e6b1eb0e29b9a8d))
* cc-skills integration — enhanced issue creation with taxonomy-aware labels, type-specific templates, and discovery provenance ([602e65d](https://github.com/terrylica/nanoclaw/commit/602e65d48055eb4ed014827ca8693bdadf2563d7))
* CLAUDE.md maintenance creates GitHub issues with full link to Telegram ([ba34620](https://github.com/terrylica/nanoclaw/commit/ba34620e16a442c69f9eb902e0b84a592034e641))
* CLAUDE.md maintenance, devil's advocate fix, OpenGrep + proactive scanning ([ce66e88](https://github.com/terrylica/nanoclaw/commit/ce66e88630d35887cce901fdd27ed2664a8612aa))
* confidence scoring, verification scripts, log rotation — 3 more FP prevention layers ([0ff2c3c](https://github.com/terrylica/nanoclaw/commit/0ff2c3c8733f2a0e0eff4ebff45d60ec62ba0f7a))
* iterative MiniMax self-validation (3 adversarial rounds) ([fc05aff](https://github.com/terrylica/nanoclaw/commit/fc05aff6bf1795978f37dcc554840c03f07cd9bc))
* Phase 0 — enable Telegram channel and Docker Compose deployment ([ebbf59c](https://github.com/terrylica/nanoclaw/commit/ebbf59c1e6387e05cce11cb4c06289e5793354f8))
* Phase 2 — MiniMax orchestrator loop for continuous validation ([17e90a3](https://github.com/terrylica/nanoclaw/commit/17e90a3c8c11d5a13768faea5964816b42e3b141))
* proactive algo correctness scanning with full Telegram + GitHub issue reporting ([4b68c3e](https://github.com/terrylica/nanoclaw/commit/4b68c3ee694f3c7880f555ea77565e5715e519ba))
* **skills:** add image vision skill for WhatsApp ([#770](https://github.com/terrylica/nanoclaw/issues/770)) ([af937d6](https://github.com/terrylica/nanoclaw/commit/af937d6453b51afb077d3797c804cecc4c9799d5))
* **skills:** add pdf-reader skill ([#772](https://github.com/terrylica/nanoclaw/issues/772)) ([0b260ec](https://github.com/terrylica/nanoclaw/commit/0b260ece5721f31d756e55abdf3f5b71757c90a9))
* **skills:** add use-local-whisper skill package ([#702](https://github.com/terrylica/nanoclaw/issues/702)) ([03f792b](https://github.com/terrylica/nanoclaw/commit/03f792bfce2b12449ab2fcaffffc35ce346da8e4))
* timezone-aware context injection for agent prompts ([#691](https://github.com/terrylica/nanoclaw/issues/691)) ([632713b](https://github.com/terrylica/nanoclaw/commit/632713b20806db2342b7f4359dd11c38866f0ec4)), closes [#483](https://github.com/terrylica/nanoclaw/issues/483) [#483](https://github.com/terrylica/nanoclaw/issues/483) [#526](https://github.com/terrylica/nanoclaw/issues/526)
* whole-repo scanning instead of 3-file batches ([1ace951](https://github.com/terrylica/nanoclaw/commit/1ace9518603ce8853a680f3c278c9d760a899993))
* wire trace UUIDs into all Telegram notifications ([b48f0e9](https://github.com/terrylica/nanoclaw/commit/b48f0e9a45b799105fc93d1e8474e44c9221a7e7))

# Changelog

All notable changes to NanoClaw will be documented in this file.

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
