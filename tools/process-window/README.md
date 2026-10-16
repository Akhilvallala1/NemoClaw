<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Process Window in GitHub Actions

The workflow builds one guidance browser with selectable `main` and `v1` maps. The editable source is `mapping.yaml` on `process-window-data`. The site shows each analyzed commit and links to that revision.

## Run before publication

Install the self-contained directory at `tools/process-window/` and the workflow at `.github/workflows/process-window.yaml` on both tracked branches. Keep `src/`, `test/`, `package.json`, `package-lock.json`, `tsconfig.json`, and `config.yaml` together. Tests use synthetic inputs. Do not copy development acceptance references, local credentials, node_modules, or the phase 1 mapping into a new discovery run.

Run **Process Window** manually with `branch: v1`, `mode: analyze`, and `publish: false`. Download `process-window-v1` and inspect `mapping.yaml`, `revision.json`, and `site/index.html`. Repeat for `main`. The optional `revision` input supports an artifact-only run at a known commit, including a phase 1 comparison revision; supplying it disables publication.

After GitHub registers the workflow, an artifact-only run can use a PR branch before merge. For example, run `gh workflow run process-window.yaml --repo NVIDIA/NemoClaw --ref codex/process-window-v1 -f branch=v1 -f mode=analyze -f publish=false`. Select the matching branch and ref for main. An explicit `revision` pins a comparison run and disables publication. Pull requests also run the tool's checks and browser tests without inference credentials. The copied entry script supports the same analysis locally with an authorized provider credential.

The example uses `PR_REVIEW_ADVISOR_API_KEY`, already used by NemoClaw for the NVIDIA inference endpoint. It is exposed only to the inference step as `PROCESS_WINDOW_API_KEY`. The YAML owns the provider, model, API protocol, timeout, and environment variable name. The workflow owns the secret binding. Credential values never belong in either file, the mapping, or artifacts. Runner teardown removes the process environment; the tool does not persist credentials.

## Enable publication

After reviewing artifacts, configure GitHub Pages to use **GitHub Actions** and allow the `github-pages` environment to deploy from `main`, `v1`, and `process-window-data`, plus the selected release tags. Set repository variable `PROCESS_WINDOW_PUBLISH` to `true`. Setting it to another value leaves automatic analysis artifact-only.

A manual publication also requires `publish: true` and a run from `main` or `v1`. Candidate branches and explicit comparison revisions cannot publish. No workflow enables Pages or changes repository settings automatically.

Merge the main integration before enabling publication from v1. The first publication creates `process-window-data` from the signed controller commit, inheriting its workflow, then adds `mapping.yaml` with a GitHub-signed commit. The branch retains that source snapshot; only its mapping is maintained. Do not develop product code on this branch. Later analysis starts with that committed mapping and retains the other branch's entries. Run and publish both branches to populate both views. The artifact-only trial does not seed this branch: the first publishing analysis independently discovers its selected branch again.

Publication needs the workflow token's `contents: write`. NemoClaw requires signed commits on every branch. Updates use [GitHub's signed-commit API](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch), then verify the signature and branch revision. The workflow inherits an existing signed commit when creating the mapping branch and never modifies workflow files through the bot token. Pages deployment has separate `pages: write` and `id-token: write` permissions. The inference job has read-only repository access. Repository rules that prohibit bot commits to the mapping branch must permit this workflow before automatic publication can succeed.

## Refresh and manual edits

After the manual pilot succeeds, set repository variable `PROCESS_WINDOW_REFRESH` to `true` to enable automatic branch and release analysis. Manual runs and mapping-edit builds do not require this variable.

- Pushes to `v1` analyze the pushed commit when its configured refresh mode is `branch`.
- Published releases select `main` only when its refresh mode is `release` and the tag matches its configured selector. The tagged commit must be an ancestor of the configured main ref; matching tags on unrelated branches fail without publication. Events outside the configured policy skip inference and publication.
- Manual runs select either branch, optionally at a specified revision.
- Commit an ordinary YAML correction to `mapping.yaml` on `process-window-data` to rebuild and deploy without inference. A manual `mode: build` run does the same.

The copied workflow on the mapping branch loads executable code from `main`, not from that mapping branch. Automated commits use `GITHUB_TOKEN`, whose pushes do not trigger another workflow; publication deploys in the originating run. Tool paths are excluded from inference to prevent the analyzer from inventorying its own prompts.

Runs share GitHub Actions concurrency through deployment, keeping the two branches from replacing each other's site. GitHub retains at most one pending run in a concurrency group; a newer event can replace a pending event. Use a manual refresh for a superseded branch when needed. Each publishing run compares the mapping branch with the revision read before analysis. A competing manual edit stops publication; rerun analysis against that edit. The signed-commit API requires the expected previous revision atomically. No force update or automatic conflict resolution is used.

The workflow retrieves the last successful relevant run's revision artifact for the selected branch. It uses that revision for the Git diff while keeping the current committed YAML as the decision baseline. Missing or expired artifacts, a missing Git object, or a successful artifact whose revision differs from the committed mapping cause full-repository reconciliation. An artifact-only trial must not hide changes the committed mapping has never seen. GitHub run status and artifacts provide the record; there is no separate status database.

## Failure and recovery

Inference and validation errors preserve the mapping and the deployed site. A concurrent mapping edit rejects the stale publication. A Pages failure preserves the last deployed site but may leave a newer validated mapping committed; rerun `mode: build` after fixing deployment. Inspect the failed run before retrying an inconclusive API write. If first-run initialization stops after creating the branch, a later analysis can add the missing mapping; a build-only run cannot.

No snapshots or history browser are built. Git history retains mapping changes. To correct an inference decision, edit YAML and rebuild. To undo a mapping change, use an ordinary revert on `process-window-data`.

## Verify locally

Run these commands inside the copied tool directory:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:browser
```

The browser test requires Chromium; install the development test browser with `npx playwright install chromium` if needed. Run `actionlint .github/workflows/process-window.yaml` from the repository root. Real-Git tests cover release ancestry and source exclusions. API contract tests cover conditional signed commits, concurrent edits, unsigned responses, unchanged mappings, and readback mismatches. They do not prove live GitHub signing or permissions; the first publishing run must establish those. Existing tests cover inference failure, manual rebuilding, source links, counts, and browser navigation.

## Reuse

Change `config.yaml` for the repository URL, branch refs, lifecycle vocabulary, source exclusions, paths, and inference settings. Adapt the workflow's repository guard, branch triggers, release selection, secret binding, and mapping branch to match. Keep a single mapping destination and separate source/controller/state checkouts. Refresh the copied implementation manually from its recorded source revision; CI does not retrieve the private development repository.
