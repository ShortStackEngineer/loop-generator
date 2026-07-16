# Changelog

## [0.1.2](https://github.com/ShortStackEngineer/loop-generator/compare/v0.1.1...v0.1.2) (2026-07-13)


### Features

* git run checkpoints and plug-in-resolution lint rules ([#37](https://github.com/ShortStackEngineer/loop-generator/issues/37)) ([f6d1a2a](https://github.com/ShortStackEngineer/loop-generator/commit/f6d1a2aaf3da9546641a3bd8f399ab0a59ac6701))

## [0.1.1](https://github.com/ShortStackEngineer/loop-generator/compare/v0.1.0...v0.1.1) (2026-07-10)


### Features

* add `loopgen batch` for running a punch list of loop specs ([ff8a6a8](https://github.com/ShortStackEngineer/loop-generator/commit/ff8a6a83118908c14c9cfc24785d6e0a4b8194e3))
* add `loopgen batch` for running a punch list of loop specs ([4a40afb](https://github.com/ShortStackEngineer/loop-generator/commit/4a40afbd22539eb937e201baedbaacabb51df0c9))
* add grok driver for xAI Grok Build CLI (headless -p) ([63912e6](https://github.com/ShortStackEngineer/loop-generator/commit/63912e6eb80b821652255b267ec7181e4c25d3d8))
* **cli:** add `generate --verify` and safer generated defaults ([b2a3813](https://github.com/ShortStackEngineer/loop-generator/commit/b2a3813835266ccd1cc4c8f7b7b4a0eb53d07d4c))
* **drivers:** add AgentEvent emit seam and shared CLI plumbing ([f0527e7](https://github.com/ShortStackEngineer/loop-generator/commit/f0527e79b8cc22aa8146dd0f9c82c6f39d96135b))
* **drivers:** add github-copilot agent driver ([5d0a042](https://github.com/ShortStackEngineer/loop-generator/commit/5d0a04248c256eba68cd62be6a7b9068c37305d4))
* **drivers:** add opencode agent driver ([f0dc58b](https://github.com/ShortStackEngineer/loop-generator/commit/f0dc58b2e06356c5ef70709ea9dbf11fe4a8a311))
* **engine:** diff feedback, off-git trust warnings, and cost/token budgets ([89c6e63](https://github.com/ShortStackEngineer/loop-generator/commit/89c6e633ffdeed49ecd19520099805538f108e50))
* **engine:** enforceable baseline + spec-tamper policy (trust guards) ([224a141](https://github.com/ShortStackEngineer/loop-generator/commit/224a141b22df4bd97896a08f63579137fd06772f))
* **engine:** evaluator-integrity guard ([0f7134f](https://github.com/ShortStackEngineer/loop-generator/commit/0f7134f3ea8fa68de01734c7b00fdd861aa038e6))
* **engine:** run evaluators sequentially by default (evaluation.concurrency) ([b7ce670](https://github.com/ShortStackEngineer/loop-generator/commit/b7ce670b048c3ae3341b4bb3e6410b85f8c07117))
* **lint:** add `loopgen lint` + run-path workspace preflight (Layer 0) ([9d12455](https://github.com/ShortStackEngineer/loop-generator/commit/9d1245552ad3bf18964ae5a37882ac985cb170c8))
* **observability:** add Stage-1 trace recorder and JSONL sink ([e7a6c6e](https://github.com/ShortStackEngineer/loop-generator/commit/e7a6c6e42691b4d40afb348c2f600bb5b44287a1))
* **observers:** add the Observer plug-in point with jsonl + OTLP built-ins ([3a5707c](https://github.com/ShortStackEngineer/loop-generator/commit/3a5707ce49eff1824bc42f2a8e7541ba797bd890))
* **observers:** nest agent turns as spans under each iteration ([553b871](https://github.com/ShortStackEngineer/loop-generator/commit/553b871c72257cd317b887fca8d95740c7d29e6f))
* **observers:** wire live OTLP/HTTP export for the otlp observer ([1639094](https://github.com/ShortStackEngineer/loop-generator/commit/16390941ec134f3f5d0823dafa1baf6c397f66b5))
* **skills:** ship author-loop, debug-loop, add-driver ([d6f31ee](https://github.com/ShortStackEngineer/loop-generator/commit/d6f31ee6ea199908f19546ae5194f8eedd63dc17))
* trustworthy loop results — change detection, honest outcomes, spec-integrity guard ([79f0ccc](https://github.com/ShortStackEngineer/loop-generator/commit/79f0ccc010aeedd2ad9724d5c3e310e63962e638))


### Bug Fixes

* address review — RED template polarity, --no-git, trust nuance ([f2e0202](https://github.com/ShortStackEngineer/loop-generator/commit/f2e02024b2c06495f185e3f452634a84d96a52b3))
* **batch:** address review — resolve-error cascade, no spec mutation, polish ([e5dbdda](https://github.com/ShortStackEngineer/loop-generator/commit/e5dbdda36703d3eb5dc6c3a088e42a70c11bf71e))
* content-hash change detection, --driver override, init-target ([f825140](https://github.com/ShortStackEngineer/loop-generator/commit/f8251401bf31ed0fe169218e3cdcd18c6031cd42))
* content-hash change detection, --driver override, init-target ([14e187b](https://github.com/ShortStackEngineer/loop-generator/commit/14e187b86a06c30dbdda8212fa47a87520ce78a3))
* **grok:** note cached-login fallback in the no-key preflight warning ([00e7748](https://github.com/ShortStackEngineer/loop-generator/commit/00e7748ad86161fd2a3213a6a35926db984bdb62))
