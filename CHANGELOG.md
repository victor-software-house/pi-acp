# [0.13.0](https://github.com/victor-software-house/pi-acp/compare/v0.12.0...v0.13.0) (2026-05-19)


### Features

* **resources:** FR-7 diagnostics surface — opt-in session-start report ([b8ef581](https://github.com/victor-software-house/pi-acp/commit/b8ef581b4559bf65047c324e19e22c72ac84b74b))

# [0.12.0](https://github.com/victor-software-house/pi-acp/compare/v0.11.0...v0.12.0) (2026-05-19)


### Features

* **resources:** FR-5 cwd-modes (none tmpdir; local/overlay passthrough) ([5eaa2c6](https://github.com/victor-software-house/pi-acp/commit/5eaa2c637a08e3cdd5f4aa9f4c9cab0e87a992a6))

# [0.11.0](https://github.com/victor-software-house/pi-acp/compare/v0.10.0...v0.11.0) (2026-05-19)


### Features

* **acp:** FR-6 read tool ACP-FS delegation via ReadOperations injection ([375e18e](https://github.com/victor-software-house/pi-acp/commit/375e18e4c6a052a8a47cbd87e214b0e8c145b9a5))

# [0.10.0](https://github.com/victor-software-house/pi-acp/compare/v0.9.0...v0.10.0) (2026-05-19)


### Features

* **resources:** add http backend with https-only fetch and per-url ttl cache ([941cd31](https://github.com/victor-software-house/pi-acp/commit/941cd316f8d441dc212303c194d39757d0a3192b))

# [0.9.0](https://github.com/victor-software-house/pi-acp/compare/v0.8.0...v0.9.0) (2026-05-19)


### Bug Fixes

* **lint:** organize ssh.ts imports ([bcb98de](https://github.com/victor-software-house/pi-acp/commit/bcb98dea1aeab944ecd9ce5486dcd5925a31b603))


### Features

* **resources:** VirtualResourceLoader + LocalBackend skeleton (PRD-002 Phase 4) ([8603587](https://github.com/victor-software-house/pi-acp/commit/8603587782f88b5e45b533a152b4df9195c768e6))
* v0.6 substrate — foundation + manifest cascade + SSH backend ([#9](https://github.com/victor-software-house/pi-acp/issues/9)) ([57d7700](https://github.com/victor-software-house/pi-acp/commit/57d77000ac37fe8278986b87734ff19402f47f75)), closes [#3](https://github.com/victor-software-house/pi-acp/issues/3)

# [0.8.0](https://github.com/victor-software-house/pi-acp/compare/v0.7.0...v0.8.0) (2026-05-19)


### Features

* **daemon:** idle shutdown + --daemon-status + --daemon-stop (PRD-003 Phase 3) ([8705ccc](https://github.com/victor-software-house/pi-acp/commit/8705ccc903c200d5fafc6d82cfb654988f1aeee3))

# [0.7.0](https://github.com/victor-software-house/pi-acp/compare/v0.6.0...v0.7.0) (2026-05-19)


### Features

* **daemon:** cross-window SessionRegistry with ownership refcounting (PRD-003 Phase 2) ([20e04e6](https://github.com/victor-software-house/pi-acp/commit/20e04e621003d84eb0546fd8c3384b97fb3df030))

# [0.6.0](https://github.com/victor-software-house/pi-acp/compare/v0.5.0...v0.6.0) (2026-05-19)


### Features

* **daemon:** introduce daemon + thin-client split (PRD-003 Phase 1) ([01a8bf8](https://github.com/victor-software-house/pi-acp/commit/01a8bf8bfa4543cef3d67149b18d7d1bcc04f1c9))

# [0.5.0](https://github.com/victor-software-house/pi-acp/compare/v0.4.0...v0.5.0) (2026-05-19)


### Features

* **auth:** drop proactive env-sniffing; classify reactively from pi runtime ([71eef46](https://github.com/victor-software-house/pi-acp/commit/71eef46da0c9c43c82699ac4d10483ab9efdf945))
* **deps:** bump SDK to ^0.22.1, pi to @earendil-works/* ^0.75.3, node >=24 ([21248c5](https://github.com/victor-software-house/pi-acp/commit/21248c54b4fcc3def5e2b75cd93206272e526e6a))
* **runtime:** redirect console.* to stderr; drive shutdown from connection lifecycle ([beaeebc](https://github.com/victor-software-house/pi-acp/commit/beaeebc27394a1916a812783a0808712dad43cfa))
* **session:** rename close/resume to stable form, keep fork unstable ([9e190c0](https://github.com/victor-software-house/pi-acp/commit/9e190c01aab35b99ce80554bb16f7675ca269c81))

# [0.4.0](https://github.com/victor-software-house/pi-acp/compare/v0.3.0...v0.4.0) (2026-03-24)


### Features

* reference cleanup, markdown fencing, model aliases, prompt queueing (v0.4.0) ([850aa4e](https://github.com/victor-software-house/pi-acp/commit/850aa4ebb19f72deedda973efdff3539046cf291))

# [0.3.0](https://github.com/victor-software-house/pi-acp/compare/v0.2.0...v0.3.0) (2026-03-23)


### Bug Fixes

* remove zod .trim() from tool-content schemas to preserve raw output ([606eeac](https://github.com/victor-software-house/pi-acp/commit/606eeac3212c94b3b2456f0b8a665622352521a9))


### Features

* implement phases 1-6 of tool output and protocol conformance plan ([ae0d96c](https://github.com/victor-software-house/pi-acp/commit/ae0d96cbcbbfbe95dc1ec2adb990f57a27989e11))

# [0.2.0](https://github.com/victor-software-house/pi-acp/compare/v0.1.2...v0.2.0) (2026-03-23)


### Features

* acp refactor phases 1-7 ([8706333](https://github.com/victor-software-house/pi-acp/commit/8706333aea7da85bde5cb15cf114c4fee5430cf2))

## [0.1.2](https://github.com/victor-software-house/pi-acp/compare/v0.1.1...v0.1.2) (2026-03-23)


### Bug Fixes

* replace buggy findPiSessionFile with cached session path resolution ([5cff8b5](https://github.com/victor-software-house/pi-acp/commit/5cff8b59361ba35a6aa9897a5d7d5da554ca8334))

## [0.1.1](https://github.com/victor-software-house/pi-acp/compare/v0.1.0...v0.1.1) (2026-03-23)


### Bug Fixes

* correct bin entry path for tsdown output ([de04b57](https://github.com/victor-software-house/pi-acp/commit/de04b57810062ecd54bffc5f0e32770e0909aad0))
