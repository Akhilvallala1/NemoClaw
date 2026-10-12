// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  verifyInstalledHistory,
  readHistoryFixtureFile,
  type HistoryFixture,
} from "./verify-installed-openclaw-history.mts";
import { privateDirectoryLibraryIdentity } from "../app/sqlite-private-directory-build.mts";
import { createHash } from "node:crypto";

const WINDOWS_POWERSHELL_ENVIRONMENT =
  /^(APPDATA|COMSPEC|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|OS|PATH|PATHEXT|PROCESSOR_ARCHITECTURE|PROCESSOR_ARCHITEW6432|SystemRoot|TEMP|TMP|USERPROFILE|WINDIR)$/iu;

for (const [name, read] of [
  ["history", readHistoryFixtureFile],
  ["private-directory library", privateDirectoryLibraryIdentity],
] as const) {
  test(`${name} reads the checked handle and rejects changed paths and hard links`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opened-fixture-controls-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "input.bin");
    const content = Buffer.from([0, 255, 128, 13, 10]);
    fs.writeFileSync(file, content);
    const expected =
      name === "history"
        ? content
        : {
            sha256: createHash("sha256").update(content).digest("hex"),
            bytes: content.length,
          };
    assert.deepEqual(read(file), expected);
    const alias = path.join(root, "alias.bin");
    fs.linkSync(file, alias);
    assert.throws(() => read(file));
    fs.unlinkSync(alias);
    const originalOpen = fs.openSync;
    const originalStat = fs.lstatSync;
    let descriptor: number | undefined;
    const open = context.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      descriptor = originalOpen(...args);
      return descriptor;
    });
    for (const kind of ["replaced", "symlink"] as const) {
      const stat = context.mock.method(
        fs,
        "lstatSync",
        (...args: Parameters<typeof fs.lstatSync>) => {
          const actual = originalStat(...args);
          return new Proxy(actual, {
            get(target, property) {
              if (property === "ino" && kind === "replaced") return Number(target.ino) + 1;
              if (property === "isSymbolicLink" && kind === "symlink") return () => true;
              return Reflect.get(target, property);
            },
          });
        },
      );
      try {
        assert.throws(() => read(file));
      } finally {
        stat.mock.restore();
      }
      assert.notEqual(descriptor, undefined);
      assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
    }
    const failedRead = context.mock.method(
      fs,
      name === "history" ? "readSync" : "readFileSync",
      () => {
        throw new Error("fixture read failure");
      },
    );
    try {
      assert.throws(() => read(file), /fixture read failure/);
    } finally {
      failedRead.mock.restore();
    }
    assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
    open.mock.restore();
    assert.deepEqual(read(file), expected);
    fs.writeFileSync(file, "");
    if (name === "private-directory library") assert.throws(() => read(file));
    else assert.deepEqual(read(file), Buffer.alloc(0));
  });
}

test("history reads enforce their bound even when the opened file grows", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "growing-history-controls-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "input.json");
  const oversized = fs.openSync(file, "wx");
  fs.ftruncateSync(oversized, 16 * 1024 * 1024 + 1);
  fs.closeSync(oversized);
  assert.throws(() => readHistoryFixtureFile(file), /exceeds its bound/);
  fs.writeFileSync(file, "{}");
  const originalStat = fs.fstatSync;
  let descriptor: number | undefined;
  context.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    descriptor = args[0];
    return originalStat(...args);
  });
  let readBytes = 0;
  context.mock.method(
    fs,
    "readSync",
    (_fd: number, buffer: Buffer, offset: number, length: number) => {
      buffer.fill(120, offset, offset + length);
      readBytes += length;
      return length;
    },
  );
  assert.throws(() => readHistoryFixtureFile(file), /exceeds its bound/);
  assert.equal(readBytes, 16 * 1024 * 1024 + 1);
  assert.notEqual(descriptor, undefined);
  assert.throws(() => originalStat(descriptor!), { code: "EBADF" });
});

test("migration history controls require original archives and complete SQLite events", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-history-controls-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixturePath = path.join(root, "fixture.json");
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. $env:HISTORY_OWNER
$fixture=New-MigrationHistoryFixture $env:HISTORY_HOME ('a' * 32) $env:HISTORY_FIXTURE
Assert-MigrationHistoryPreserved $fixture
$failed=$false
try { New-MigrationHistoryFixture $env:HISTORY_HOME ('a' * 32) $env:HISTORY_FIXTURE } catch { $failed=$true }
if (-not $failed) { throw 'A second seed replaced existing history.' }
$original=[IO.File]::ReadAllBytes($fixture.store)
[IO.File]::WriteAllBytes($fixture.store,([byte[]](239,187,191)+$original))
$failed=$false
try { Assert-MigrationHistoryPreserved $fixture } catch { $failed=$true }
if (-not $failed) { throw 'A byte-changing history mutation was accepted.' }
[IO.File]::WriteAllBytes($fixture.store,$original)
Assert-MigrationHistoryPreserved $fixture
foreach ($size in @(0,8192,1100000)) {
  $stream=[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('x' * $size))
  $reader=[IO.StreamReader]::new($stream)
  try {
    $capture=New-MigrationOutputCapture 'fixture' $reader
    for ($poll=0; $poll -lt 100 -and -not $capture.done; $poll++) { Update-MigrationOutputCapture $capture }
    if (-not $capture.done -or $capture.failed -or $capture.text.Length -gt 1048576 -or
        $capture.overflow -ne ($size -gt 1048576)) { throw 'Migration output bounds failed.' }
    if ($size -le 1048576 -and $capture.text.Length -ne $size) { throw 'Bounded migration output lost data.' }
  } finally { $reader.Dispose(); $stream.Dispose() }
}
Write-Output 'pass'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: powershellEnvironment({
        HISTORY_OWNER: fileURLToPath(new URL("./preview-history-controls.ps1", import.meta.url)),
        HISTORY_HOME: path.join(root, "home"),
        HISTORY_FIXTURE: fixturePath,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "pass");
  const fixture: HistoryFixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.throws(() => verifyInstalledHistory(fixture), "Unmigrated JSON must not qualify.");
  const archive = path.join(
    path.dirname(path.dirname(fixture.store)),
    "session-sqlite-import-archive",
  );
  fs.mkdirSync(archive);
  const storeArchive = path.join(archive, "legacy-store.sessions.json.imported-1");
  const transcriptArchive = path.join(archive, "transcript.imported-1.jsonl");
  fs.renameSync(fixture.store, storeArchive);
  fs.renameSync(fixture.transcript, transcriptArchive);
  assert.throws(() => verifyInstalledHistory(fixture), "Archives alone must not qualify.");
  const database = path.join(fixture.home, ".openclaw", "history.sqlite");
  const db = new DatabaseSync(database);
  try {
    db.exec(
      "CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)",
    );
    db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(
      fixture.sessionKey,
      fixture.sessionId,
    );
    const events = fixture.transcriptText.trimEnd().split("\n");
    const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)");
    events.forEach((event, index) => insert.run(fixture.sessionId, index, event));
    const observed = verifyInstalledHistory(fixture);
    assert.equal(observed.importedEvents, 3);
    assert.equal(observed.archives.length, 2);
    assert.deepEqual(verifyInstalledHistory(fixture), observed);
    fs.appendFileSync(storeArchive, " ");
    assert.throws(() => verifyInstalledHistory(fixture));
    fs.writeFileSync(storeArchive, fixture.storeText);
    fs.appendFileSync(transcriptArchive, " ");
    assert.throws(() => verifyInstalledHistory(fixture));
    fs.writeFileSync(transcriptArchive, fixture.transcriptText);
    fs.copyFileSync(storeArchive, path.join(archive, "legacy-store.sessions.json.imported-2"));
    assert.throws(() => verifyInstalledHistory(fixture));
    fs.unlinkSync(path.join(archive, "legacy-store.sessions.json.imported-2"));
    db.prepare("DELETE FROM transcript_events WHERE seq = 2").run();
    assert.throws(() => verifyInstalledHistory(fixture));
    insert.run(fixture.sessionId, 2, events[2]);
    db.prepare("UPDATE session_nodes SET current_session_id = 'another-session'").run();
    assert.throws(() => verifyInstalledHistory(fixture));
    db.prepare("UPDATE session_nodes SET current_session_id = ?").run(fixture.sessionId);
    assert.deepEqual(verifyInstalledHistory(fixture), observed);
  } finally {
    db.close();
  }
});

test("migration launch controller requires owned observations, normal exit and cleanup receipt", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-launch-controls-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, "child.cjs");
  // These child processes test controller ordering and result propagation only.
  // The actual installed UI observer and MXC cleanup remain Windows E2E contracts.
  fs.writeFileSync(
    child,
    String.raw`
const fs=require('node:fs'), path=require('node:path');
setTimeout(()=>process.exit(9),10000).unref();
const args=process.argv.slice(2);
const value=name=>args[args.indexOf(name)+1];
const stopped=()=>fs.readdirSync(process.env.HISTORY_EVIDENCE).some(name=>/^observer-stop-[a-f0-9]{64}\.sentinel$/.test(name));
if(args.includes('--configured')) {
  const session=value('--artifact-directory');
  fs.mkdirSync(session);
  const timer=setInterval(()=>{
    if(!stopped()) return;
    clearInterval(timer);
    if(process.env.HISTORY_SCENARIO!=='missing-receipt') {
      fs.writeFileSync(path.join(session,'native-windows-web-ui-abc.json'),JSON.stringify({
        verdict:'pass',runtimeIdentity:{runtimeId:process.env.HISTORY_RUNTIME,sourceRevision:process.env.GITHUB_SHA},
        backend:'process_container',sandboxDeleted:true,sandboxRegistryAbsent:true,gatewayStopped:true,qualificationRootsRemoved:true
      }));
    }
    process.exit(process.env.HISTORY_SCENARIO==='failed-guardian'?1:0);
  },20);
} else {
  const pid=Number(value('-RootProcessId'));
  console.log(JSON.stringify({kind:'observation',rootPid:process.env.HISTORY_SCENARIO==='wrong-owner'?pid+1:pid,
    hostPath:process.env.HISTORY_HOST,windowFound:true,openEnabled:true}));
  const timer=setInterval(()=>{
    if(!stopped()) return;
    clearInterval(timer);
    console.log(JSON.stringify({kind:'stop-invoked'}));
    console.log(JSON.stringify({kind:'closed',exitCode:0}));
  },20);
}
`,
    { flag: "wx" },
  );
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. $env:HISTORY_OWNER
function New-PreviewProcess([string]$Executable, [string[]]$Arguments) {
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$env:HISTORY_NODE; $info.UseShellExecute=$false
  $info.ArgumentList.Add($env:HISTORY_CHILD)
  foreach($argument in $Arguments) { $info.ArgumentList.Add($argument) }
  return $info
}
$env:HISTORY_HOST=Join-Path $env:HISTORY_INSTALL ('runtimes\'+$env:HISTORY_RUNTIME+'\app\NemoClaw.Runtime.exe')
$env:GITHUB_SHA='c'*40
if(-not $env:SystemRoot) { $env:SystemRoot=$env:HISTORY_INSTALL }
foreach($scenario in @('success','wrong-owner','missing-receipt','failed-guardian')) {
  $env:HISTORY_SCENARIO=$scenario
  $env:HISTORY_EVIDENCE=Join-Path $env:HISTORY_ROOT $scenario
  $script:MigrationSessionOpen=$false
  $failed=$false
  try { Invoke-MigrationHistorySession $env:HISTORY_INSTALL $env:HISTORY_RUNTIME $env:HISTORY_EVIDENCE }
  catch { $failed=$true }
  $receipt=Get-Content -LiteralPath (Join-Path $env:HISTORY_EVIDENCE 'history-session.json') -Raw | ConvertFrom-Json
  if($scenario -ceq 'success') {
    if($failed -or $script:MigrationSessionOpen -or -not $receipt.passed -or -not $receipt.stopInvoked) { throw 'Normal migration lifecycle was not accepted.' }
  } else {
    if(-not $failed -or -not $script:MigrationSessionOpen -or $receipt.passed) { throw 'Unconfirmed migration cleanup became success.' }
    if($receipt.ready -ne ($scenario -cne 'wrong-owner') -or
       $receipt.closed -ne ($scenario -cne 'wrong-owner')) { throw 'The fixture failed before its intended lifecycle boundary.' }
  }
}
Write-Output 'pass'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: powershellEnvironment({
        HISTORY_OWNER: fileURLToPath(new URL("./preview-history-controls.ps1", import.meta.url)),
        HISTORY_ROOT: root,
        HISTORY_INSTALL: path.join(root, "installation"),
        HISTORY_NODE: process.execPath,
        HISTORY_CHILD: child,
        HISTORY_RUNTIME: "a".repeat(64),
        RUNNER_TEMP: root,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "pass");
});

function powershellEnvironment(extra: NodeJS.ProcessEnv = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => WINDOWS_POWERSHELL_ENVIRONMENT.test(name)),
    ),
    ...extra,
  };
}

test("setup receives only installation environment while the controller retains credentials", (context) => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = $ast.Find({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-OwnedSetup'
}, $true)
if ($null -eq $owner) { throw 'Setup process owner is missing.' }
$launch = '[Diagnostics.Process]::Start($info)'
if ($owner.Extent.Text.Split($launch).Count -ne 2) { throw 'Setup process boundary is ambiguous.' }
. ([scriptblock]::Create($owner.Extent.Text.Replace($launch, '(Start-Fixture $info)')))
$setup = 'owned-setup-fixture'
$timings = @{ stages = @{} }
$allowed = @('SystemRoot','WINDIR','SystemDrive','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS','OS','PATH')
$script:starts = 0; $script:waits = 0; $script:disposals = 0
function Start-Fixture($Info) {
  $script:starts++
  if ($Info.FileName -cne $setup -or $Info.UseShellExecute -or -not $Info.CreateNoWindow) { throw 'Setup process options changed.' }
  if (($Info.ArgumentList -join '|') -cne ($action + '|-quiet|-norestart|-log|fixture.log')) { throw 'Setup arguments changed.' }
  foreach ($name in $Info.Environment.Keys) {
    if ($name -notin $allowed) { throw 'Setup inherited an unapproved environment variable.' }
  }
  foreach ($name in @('NVIDIA_API_KEY','NVIDIA_INFERENCE_API_KEY','nvidia_api_key','GITHUB_TOKEN','NODE_OPTIONS','UNRELATED_SECRET')) {
    if ($Info.Environment.ContainsKey($name)) { throw 'Setup inherited a controller credential or override.' }
  }
  if ($Info.Environment['TEMP'] -cne $env:TEMP -or $Info.Environment['USERPROFILE'] -cne $env:USERPROFILE) { throw 'Required installation environment was lost.' }
  $expectedPath = [Environment]::SystemDirectory + ';' + [Environment]::GetEnvironmentVariable('SystemRoot')
  if ($Info.Environment['PATH'] -cne $expectedPath) { throw 'Setup inherited executable search paths.' }
  $process = [pscustomobject]@{ ExitCode = $exitCode }
  $process | Add-Member ScriptMethod WaitForExit { $script:waits++ }
  $process | Add-Member ScriptMethod Dispose { $script:disposals++ }
  return $process
}
foreach ($action in @('-install','-uninstall')) {
  foreach ($exitCode in @(0,17)) {
    $caught = $null
    try { Invoke-OwnedSetup $action 'fixture.log' } catch { $caught = $_ }
    if ($exitCode -eq 0 -and $null -ne $caught) { throw $caught }
    if ($exitCode -ne 0 -and ($null -eq $caught -or $caught.Exception.Message -cne "Finished preview $action failed with status $exitCode.")) { throw 'Setup process failure was lost.' }
    if ($timings.stages[$action].exitCode -ne $exitCode) { throw 'Setup evidence lost the process result.' }
    if ($env:NVIDIA_API_KEY -cne 'synthetic-api-canary' -or $env:NVIDIA_INFERENCE_API_KEY -cne 'synthetic-inference-canary') { throw 'Controller credentials were changed.' }
  }
}
if ($script:starts -ne 4 -or $script:waits -ne 4 -or $script:disposals -ne 4) { throw 'Setup process lifecycle changed.' }
Write-Output 'SETUP_ENVIRONMENT_4_PASS'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: powershellEnvironment({
        ACCEPTANCE_SOURCE: fileURLToPath(new URL("run-installed-acceptance.ps1", import.meta.url)),
        NVIDIA_API_KEY: "synthetic-api-canary",
        NVIDIA_INFERENCE_API_KEY: "synthetic-inference-canary",
        GITHUB_TOKEN: "synthetic-github-canary",
        NODE_OPTIONS: "synthetic-override-canary",
        UNRELATED_SECRET: "synthetic-unrelated-canary",
        TEMP: process.env.TEMP ?? "/tmp",
        USERPROFILE: process.env.USERPROFILE ?? "/tmp",
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SETUP_ENVIRONMENT_4_PASS/u);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-.*-canary/u);
});

test("legacy reset claims fresh Hermes state before normal Hermes setup", (context) => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:QUALIFIER_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Package qualifier does not parse.' }
$main = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
if ($main.Count -ne 1) { throw 'The qualification lifecycle owner is ambiguous.' }
$loops = @($main[0].Body.Statements | Where-Object {
  $_ -is [Management.Automation.Language.ForEachStatementAst] -and
  $_.Condition.Extent.Text -ceq '$nativeAgentChoices'
})
if ($loops.Count -ne 1) { throw 'The setup selection owner is ambiguous.' }
$execute = [scriptblock]::Create($loops[0].Extent.Text)
function Invoke-NativeSetupSelection {
  param($Agent, $ChoiceId, [switch]$Maintenance, [switch]$ReplaceOwned)
  if ($Agent -ceq 'openclaw') {
    if ($Maintenance -or $ReplaceOwned -or $script:installed) { throw 'First install must not adopt existing data.' }
    $script:installed = $true
  } elseif ($Agent -ceq 'hermes') {
    if (-not $script:reset -or -not $Maintenance -or -not $ReplaceOwned) { throw 'Hermes must reuse only reset-owned configuration.' }
  } else { throw 'Retired agent selected.' }
  $script:operations.Add('setup-' + $Agent)
  return @{agent=$Agent;automationId=$ChoiceId}
}
function Invoke-NativeTesterResetQualification {
  if (-not $script:installed -or $script:reset) { throw 'Reset requires one installed candidate.' }
  if ($nativeSelections.Count -ne 1 -or $nativeSelections[0].agent -cne 'openclaw') { throw 'Hermes state was used before reset.' }
  $script:operations.Add('reset-hermes')
  if ($failReset) { throw 'fresh-state-denied' }
  $script:reset = $true
  return @{passed=$true}
}
foreach ($failReset in @($false,$true)) {
  $nativeAgentChoices = @(@{agent='openclaw';automationId='AgentOpenClaw'},@{agent='hermes';automationId='AgentHermes'})
  $nativeSelections = @(); $testerResetEvidence = $null
  $script:installed = $false; $script:reset = $false
  $script:operations = [Collections.Generic.List[string]]::new()
  $failed = $false
  try { . $execute } catch {
    if ($_.Exception.Message -cne 'fresh-state-denied') { throw }
    $failed = $true
  }
  if ($failed -ne $failReset) { throw 'Reset rejection was lost.' }
  $expected = if ($failReset) { 'setup-openclaw,reset-hermes' } else { 'setup-openclaw,reset-hermes,setup-hermes' }
  if (($script:operations -join ',') -cne $expected) { throw 'Setup and reset crossed their ownership order.' }
  if ($nativeSelections.Count -ne $(if ($failReset) { 1 } else { 2 })) { throw 'Selection receipts were replaced.' }
  if (($null -ne $testerResetEvidence) -eq $failReset) { throw 'Reset evidence does not match the outcome.' }
}
$resetAst = [Management.Automation.Language.Parser]::ParseFile($env:RESET_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Reset controller does not parse.' }
$save = @($resetAst.FindAll({ param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$selection'
}, $true))
if ($save.Count -ne 1) { throw 'Reset canary configuration owner is ambiguous.' }
function Invoke-NativeSetupSelection {
  param($Agent, $ChoiceId, [switch]$Standalone, [switch]$ReplaceOwned, $Inference, $Endpoint, $CredentialCanary, $EvidenceName)
  if ($Agent -cne 'hermes' -or $ChoiceId -cne 'AgentHermes' -or -not $Standalone -or $ReplaceOwned -or
      $Inference -cne 'compatible' -or $CredentialCanary -cne 'fixture-key') { throw 'Fresh reset configuration tried to adopt prior user settings.' }
  return @{agent=$Agent}
}
$endpoint = 'https://127.0.0.1:17193/fixture/v1'; $canary = 'fixture-key'
. ([scriptblock]::Create($save[0].Extent.Text))
if ($selection.agent -cne 'hermes') { throw 'Reset did not save its fresh selected-agent configuration.' }
Write-Output 'RESET_ORDER_3_PASS'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: powershellEnvironment({
        QUALIFIER_SOURCE: fileURLToPath(
          new URL(
            "../../../scripts/checks/run-windows-native-package-qualification.ps1",
            import.meta.url,
          ),
        ),
        RESET_SOURCE: fileURLToPath(
          new URL(
            "../../../scripts/checks/qualify-windows-native-tester-reset.ps1",
            import.meta.url,
          ),
        ),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESET_ORDER_3_PASS/u);
});

test(
  "Burn fixture accepts MXC capability details but rejects ambiguous preparation decisions",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:BURN_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Burn fixture source does not parse.' }
$owner = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Read-DiagnosticPreparationTier' }, $true)
if ($null -eq $owner) { throw 'Preparation decision owner missing.' }
. ([scriptblock]::Create($owner.Extent.Text))
foreach ($tier in @('base-container','appcontainer-dacl')) {
    $augment = $tier -ceq 'appcontainer-dacl'
    foreach ($extended in @($false,$true)) {
        $record = @{tier=$tier;needsDaclAugmentation=$augment}
        if ($extended) { $record.warnings=@();$record.probes=@{baseContainerApiPresent=(-not $augment);uiCapabilities=@{canBlockClipboardRead=$true}} }
        if ((Read-DiagnosticPreparationTier ($record|ConvertTo-Json -Depth 5)) -cne $tier) { throw 'Valid MXC capabilities rejected.' }
    }
}
$invalid = @(
    '{broken', '{}', '[]', (' ' * 8193),
    ('{"tier":"base-container","needsDaclAugmentation":false,"probes":' + ('[' * 9) + '0' + (']' * 9) + '}'),
    '{"tier":"base-container","needsDaclAugmentation":true}',
    '{"tier":"appcontainer-dacl","needsDaclAugmentation":false}',
    '{"tier":"base-container","needsDaclAugmentation":"false"}',
    '{"tier":"base-container","needsDaclAugmentation":null}',
    '{"tier":"base-container","needsDaclAugmentation":0}',
    '{"tier":"BASE-CONTAINER","needsDaclAugmentation":false}',
    '{"tier":"unknown","needsDaclAugmentation":false}',
    '{"tier":"base-container","tier":"appcontainer-dacl","needsDaclAugmentation":true}',
    '{"tier":"base-container","needsDaclAugmentation":true,"needsDaclAugmentation":false}',
    '{"tier":"base-container","needsDaclAugmentation":false,"warnings":[],"warnings":[]}'
)
foreach ($text in $invalid) {
    $rejected=$false
    try { $null=Read-DiagnosticPreparationTier $text } catch { $rejected=$true }
    if (-not $rejected) { throw 'Ambiguous or invalid MXC capabilities accepted.' }
}
Write-Output 'PREPARATION_SCHEMA_19_PASS'
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: powershellEnvironment({
        BURN_SOURCE: fileURLToPath(new URL("test-burn-diagnostics.ps1", import.meta.url)),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PREPARATION_SCHEMA_19_PASS/u);
  },
);

test(
  "tester reset preserves primary failure and retains recovery for incomplete cleanup",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:RESET_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Reset source does not parse.' }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-NativeTesterResetQualification' }, $true)
$statements = @($function.Body.EndBlock.Statements)
$owner = @($statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[0]
$index = [array]::IndexOf($statements, $owner)
if ($statements[$index+1] -isnot [Management.Automation.Language.IfStatementAst] -or
    $statements[$index+2] -isnot [Management.Automation.Language.IfStatementAst]) { throw 'Reset outcome handling changed.' }
$body = 'try { if ($mainFailure) { throw "primary-fixture-failure" } } ' +
  ($owner.CatchClauses.Extent.Text -join ' ') + ' finally ' + $owner.Finally.Extent.Text +
  $statements[$index+1].Extent.Text + $statements[$index+2].Extent.Text
$execute = [scriptblock]::Create($body)
function Fail-PackageQualification($message) { throw $message }
function Invoke-NativeCredentialHelper {
  param($LauncherPath, $Arguments)
  $calls.Add($Arguments[0])
  switch ($Arguments[0]) {
    '--credential-read' {
      if ($testCase -ceq 'read-throws') { throw 'synthetic-sensitive-diagnostic' }
      return @{ exitCode = 0; stdout = $(if ($testCase -ceq 'identity-drift') { 'other-key' } else { $canary }) }
    }
    '--credential-delete' { return @{ exitCode = $(if ($testCase -cin @('key-fails','both-fail')) { 1 } else { 0 }) } }
    '--state-remove' { return @{ exitCode = $(if ($testCase -cin @('state-fails','both-fail')) { 1 } else { 0 }) } }
    default { throw 'Unexpected cleanup operation.' }
  }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('reset-cleanup-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
  foreach ($mainFailure in @($false,$true)) {
    foreach ($testCase in @('pass','key-fails','state-fails','both-fail','read-throws','identity-drift','live','wait-throws')) {
      $helper = Join-Path $root 'helper.exe'; [IO.File]::WriteAllText($helper, 'inert-test-data')
      $helperHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
      $primary = $null; $cleanupErrors = [Collections.Generic.List[string]]::new()
      $calls = [Collections.Generic.List[string]]::new(); $ownsKey = $true; $ownsState = $true
      $binding = 'fixture-binding'; $canary = 'synthetic-private-key'; $window = $null
      $script:disposed = 0; $script:waits = 0; $script:OperationTimeoutMilliseconds = 1
      $process = [pscustomobject]@{ HasExited = $false }
      $process | Add-Member ScriptMethod WaitForExit {
        param($timeout)
        $script:waits++
        if ($testCase -ceq 'wait-throws') { throw 'query-failed' }
        return $testCase -cne 'live'
      }
      $process | Add-Member ScriptMethod Dispose { $script:disposed++ }
      $caught = $null
      try { . $execute -WarningAction SilentlyContinue } catch { $caught = $_ }
      $failedCleanup = $testCase -cne 'pass'
      if (($null -ne $caught) -ne ($mainFailure -or $failedCleanup)) { throw ('Wrong outcome: ' + $testCase) }
      if ($mainFailure -and $caught.Exception.Message -cne 'primary-fixture-failure') { throw 'Primary error replaced.' }
      if ($mainFailure -and $failedCleanup -and -not $caught.Exception.Data.Contains('NemoClawCleanupErrors')) { throw 'Secondary errors lost.' }
      if ($script:disposed -ne 1 -or $script:waits -ne 1) { throw 'Process was not observed and disposed.' }
      if ($testCase -cin @('live','wait-throws')) {
        if ($calls.Count -ne 0) { throw 'Cleanup overlapped a live or unconfirmed installer.' }
      } elseif ($calls -notcontains '--state-remove') { throw 'State cleanup was skipped after key failure.' }
      if ($testCase -cin @('identity-drift','read-throws') -and $calls -contains '--credential-delete') { throw 'Unowned key deleted.' }
      if ((Test-Path -LiteralPath $helper) -ne $failedCleanup) { throw 'Wrong recovery helper retention.' }
      if (($cleanupErrors -join ' ').Contains('synthetic-')) { throw 'Sensitive diagnostic leaked.' }
    }
  }
  Write-Output 'RESET_CLEANUP_16_PASS'
} finally { [IO.Directory]::Delete($root, $true) }
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: powershellEnvironment({
        RESET_SOURCE: fileURLToPath(
          new URL(
            "../../../scripts/checks/qualify-windows-native-tester-reset.ps1",
            import.meta.url,
          ),
        ),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RESET_CLEANUP_16_PASS/u);
  },
);

test(
  "acceptance rejects unsupported scopes and credentials before installing",
  { skip: process.platform !== "win32" },
  () => {
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "run-installed-acceptance.ps1",
    );
    for (const [agent, scope, mode, secret, expected] of [
      ["pi", "full-acceptance", "current-build", "", "does not belong to the set"],
      ["nemocua", "full-acceptance", "current-build", "", "does not belong to the set"],
      [
        "langchain-deepagents-code",
        "full-acceptance",
        "current-build",
        "",
        "does not belong to the set",
      ],
      ["hermes", "startup-only", "built-0.1.3-replay", "", "Only OpenClaw"],
      ["hermes", "startup-only", "current-build", "", "Startup-only smoke supports"],
      ["openclaw", "startup-only", "built-0.1.3-replay", "", "Startup-only smoke supports"],
      [
        "openclaw",
        "startup-only",
        "current-build",
        "NVIDIA_API_KEY",
        "must not receive inference credentials",
      ],
      [
        "openclaw",
        "startup-only",
        "current-build",
        "NVIDIA_INFERENCE_API_KEY",
        "must not receive inference credentials",
      ],
      ["openclaw", "startup-only", "current-build", "", "requires explicit Windows CI identities"],
      [
        "openclaw",
        "full-acceptance",
        "current-build",
        "",
        "requires explicit Windows CI identities",
      ],
      ["hermes", "full-acceptance", "current-build", "", "requires explicit Windows CI identities"],
    ]) {
      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
      try {
        & $env:NEMOCLAW_ACCEPTANCE_SOURCE -SourceRoot . -WorkDirectory . -ProductVersion 0.1.9 -ArtifactSourceRevision invalid -Agent $env:TEST_AGENT -ValidationScope $env:TEST_SCOPE -Mode $env:TEST_MODE
        throw 'Unexpected acceptance success'
      } catch { Write-Output $_.Exception.Message; exit 0 }
    `,
        ],
        {
          env: powershellEnvironment({
            NEMOCLAW_ACCEPTANCE_SOURCE: source,
            TEST_AGENT: agent,
            TEST_SCOPE: scope,
            TEST_MODE: mode,
            ...(secret ? { [secret]: "synthetic-never-log-this-value" } : {}),
          }),
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(expected), result.stdout);
      assert.ok(!(result.stdout + result.stderr).includes("synthetic-never-log-this-value"));
    }
  },
);

test(
  "acceptance consumes the four-file same-run controller proof",
  { skip: process.platform !== "win32" },
  () => {
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "run-installed-acceptance.ps1",
    );
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$work = Join-Path ([IO.Path]::GetTempPath()) ('installed-controller-proof-' + [guid]::NewGuid().ToString('N'))
$trustedNodeDirectory = "$work-controller-node"
try {
  $controls = Join-Path $work 'application\controls'
  $fakeNode = Join-Path $trustedNodeDirectory 'node.exe'
  [IO.Directory]::CreateDirectory($controls) | Out-Null
  [IO.Directory]::CreateDirectory((Split-Path -Parent $fakeNode)) | Out-Null
  [IO.File]::WriteAllBytes($fakeNode, [byte[]]@(0))
  $revision = (& git -C $env:NEMOCLAW_SOURCE_ROOT rev-parse HEAD | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $revision -cnotmatch '^[a-f0-9]{40}$') { throw 'Fixture source identity failed.' }
  $files = @(
    'packaging/windows/installer/control-installed-openclaw-input.test.mts',
    'packaging/windows/installer/run-installed-acceptance.test.mts',
    'packaging/windows/installer/qualify-finished-package.test.mts',
    'packaging/windows/runtime/native-ui-tunnel.test.mts'
  )
  $rows = @($files | ForEach-Object {
    $file = Join-Path $env:NEMOCLAW_SOURCE_ROOT $_
    @{ file = $_; bytes = (Get-Item -LiteralPath $file).Length; sha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  [IO.File]::WriteAllText((Join-Path $controls 'installed-acceptance-controller.json'), (@{
    schemaVersion = 1
    classification = 'same-run-installed-acceptance-controller-controls'
    sourceRevision = $revision
    nodeSha256 = '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'
    passed = $true
    files = $rows
  } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  function Get-FileHash {
    param([string]$LiteralPath, [string]$Algorithm = 'SHA256')
    if ($LiteralPath -ceq $fakeNode) {
      return [pscustomobject]@{ Hash = '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878' }
    }
    Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
  }
  $env:GITHUB_ACTIONS = 'true'; $env:GITHUB_SHA = $revision; $env:OS = 'Windows_NT'
  try {
    & $env:NEMOCLAW_ACCEPTANCE_SOURCE -SourceRoot $env:NEMOCLAW_SOURCE_ROOT -WorkDirectory $work -ProductVersion 0.1.10 -ArtifactSourceRevision $revision -Agent openclaw -Mode current-build -ControllerNodePath $fakeNode
    throw 'Unexpected acceptance success.'
  } catch {
    if ($_.Exception.Message -notlike '*immutable-package-build.json*' -and
        $_.Exception.Message -cne 'Fresh preview acceptance requires no preexisting NemoClaw installation.') {
      throw
    }
  }
  Write-Output 'SAME_RUN_CONTROLLER_PROOF_PASS'
} finally {
  if (Test-Path -LiteralPath $work) { [IO.Directory]::Delete($work, $true) }
  if (Test-Path -LiteralPath $trustedNodeDirectory) { [IO.Directory]::Delete($trustedNodeDirectory, $true) }
}
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: powershellEnvironment({
        NEMOCLAW_ACCEPTANCE_SOURCE: source,
        NEMOCLAW_SOURCE_ROOT: sourceRoot,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /SAME_RUN_CONTROLLER_PROOF_PASS/u);
  },
);

test(
  "startup acceptance checks the smoke process and receipt without running live acceptance",
  { skip: process.platform !== "win32" },
  () => {
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "run-installed-acceptance.ps1",
    );
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
$branch = @($owner[0].Body.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })
$execute = [scriptblock]::Create($branch[0].Extent.Text)
$ValidationScope = 'startup-only'; $Agent = 'openclaw'; $SourceRoot = 'source-fixture'
$work = 'work-fixture'; $installation = 'install-fixture'; $ciNode = 'Invoke-TestSmoke'
function Invoke-TestSmoke {
  if ($args -contains '--browser-driver-root' -or $args -notcontains '--agent' -or $args -notcontains 'openclaw' -or
      $args -notcontains 'source-fixture\packaging\windows\installer\qualify-finished-package.mts') { throw 'Unexpected installed test route.' }
  $global:LASTEXITCODE = $testExit
}
function Get-Content {
  param($LiteralPath, [switch]$Raw)
  if ($LiteralPath -cne 'work-fixture\installed-smoke\finished-package-smoke.json') { throw 'Unexpected receipt path.' }
  return $testReceipt
}
$count = 0
foreach ($case in @('pass','exit','receipt-fail','wrong-agent','wrong-scope','full-claim','truncated','missing','string-false')) {
  $timings = @{}; $testExit = if ($case -ceq 'exit') { 1 } else { 0 }
  $receipt = @{ verdict='pass'; agent='openclaw'; validationScope='startup-only'; fullInstalledQualification=$false }
  switch ($case) {
    'receipt-fail' { $receipt.verdict = 'fail' }
    'wrong-agent' { $receipt.agent = 'pi' }
    'wrong-scope' { $receipt.validationScope = 'full-acceptance' }
    'full-claim' { $receipt.fullInstalledQualification = $true }
    'missing' { $receipt.Remove('fullInstalledQualification') }
    'string-false' { $receipt.fullInstalledQualification = 'False' }
  }
  $testReceipt = if ($case -ceq 'truncated') { '{' } else { $receipt | ConvertTo-Json -Compress }
  $failed = $false
  try { . $execute } catch { $failed = $true }
  if ($failed -ne ($case -cne 'pass')) { throw ('Unexpected startup result: ' + $case) }
  if ($timings.ContainsKey('startupSmoke') -ne ($case -ceq 'pass')) { throw 'Failed smoke acquired a success receipt.' }
  if ($case -ceq 'pass' -and $timings.startupSmoke.deterministicLocalModel -ne $true) { throw 'Missing mock-model scope.' }
  $count++
}
Write-Output $count
`;
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: powershellEnvironment({
          NEMOCLAW_ACCEPTANCE_SOURCE: source,
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "9");
  },
);

for (const agent of ["hermes"])
  test(
    `${agent} installed acceptance runs cold and saved-configuration launches and rejects incomplete evidence`,
    { skip: process.platform !== "win32" },
    () => {
      const source = fileURLToPath(new URL("./run-installed-acceptance.ps1", import.meta.url));
      const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
$branch = @($owner[0].Body.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })
# Replace only the external process boundary; execute the actual case loop,
# argument routing and evidence checks without installing or contacting inference.
$execute = [scriptblock]::Create($branch[0].Extent.Text.Replace('& $ciNode', '& Invoke-TestAgent'))
$ValidationScope = 'full-acceptance'; $Agent = $env:TEST_AGENT; $SourceRoot = 'source-fixture'
$work = 'work-fixture'; $installation = 'install-fixture'
function Invoke-TestAgent {
  if ($args -notcontains "source-fixture\packaging\windows\installer\qualify-installed-$Agent.mts") { throw 'Wrong agent controller.' }
  $first = $calls.Count -eq 0
  if (($args -contains '--preserve-configuration') -ne $first -or ($args -contains '--reuse-configuration') -eq $first) { throw ('Incorrect cold/warm configuration routing: ' + ($args -join ',') + '; first=' + $first) }
  $previous = [array]::IndexOf($args, '--previous-acceptance')
  if (($previous -ge 0) -ne (-not $first)) { throw 'Incorrect cold-run receipt routing.' }
  if ($previous -ge 0 -and $args[$previous+1] -cne "work-fixture\installed-acceptance\installed-$Agent-acceptance.json") { throw 'Wrong cold-run receipt.' }
  $calls.Add(@($args))
  $global:LASTEXITCODE = if ($scenario -ceq 'process-failure') { 1 } else { 0 }
}
function Get-Content {
  param($LiteralPath, [switch]$Raw)
  $directory = if ($calls.Count -eq 1) { 'installed-acceptance' } else { 'installed-acceptance-warm' }
  if ($LiteralPath -cne "work-fixture\$directory\installed-$Agent-acceptance.json") { throw 'Wrong agent receipt.' }
  $receipt = @{ classification='installed-canonical-hermes-acceptance'; verdict='pass'; cleanupErrors=@(); results=@{
    realTerminal=$true; realModelReply=$true; fileToolsQualified=$true; turns=@(@{},@{fileTools=$true}); configurationReused=($calls.Count -eq 2)
  } }
  switch ($scenario) {
    'failed-receipt' { $receipt.verdict='fail' }
    'cleanup-failure' { $receipt.cleanupErrors=@('retained process') }
  }
  return ($receipt | ConvertTo-Json -Depth 6)
}
$count=0
$scenarios=@('pass','process-failure','failed-receipt','cleanup-failure')
foreach ($scenario in $scenarios) {
  $calls=[Collections.Generic.List[object]]::new(); $timings=@{}; $failed=$false
  try { . $execute } catch { if ($scenario -ceq 'pass') { throw }; $failed=$true }
  if ($failed -ne ($scenario -cne 'pass')) { throw ('Unexpected Hermes acceptance result: '+$scenario) }
  if ($scenario -ceq 'pass' -and ($calls.Count -ne 2 -or $timings.startupComparisonAvailable -ne $true)) { throw 'Incorrect launch comparison result.' }
  if ($failed -and $timings.startupComparisonAvailable -eq $true) { throw 'A failed case claimed a startup comparison.' }
  $count++
}
Write-Output $count
`;
      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: powershellEnvironment({ NEMOCLAW_ACCEPTANCE_SOURCE: source, TEST_AGENT: agent }),
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout.trim(), "4");
    },
  );

for (const shell of ["powershell.exe", "pwsh.exe"])
  test(
    `${shell} treats absent diagnostics as optional and preserves failures`,
    {
      skip: process.platform !== "win32",
    },
    () => {
      const source = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "run-installed-acceptance.ps1",
      );
      const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
if ($owner.Count -ne 1) { throw 'Expected one acceptance cleanup owner.' }
$root = 'Registry::HKEY_CURRENT_USER\Software\NemoClawAcceptanceTest-' + [guid]::NewGuid().ToString('N')
$productionPath = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\NVIDIA\NemoClaw\InstallDiagnostics'
$body = $owner[0].Finally.Statements[0].Extent.Text
if (-not $body.Contains($productionPath)) { throw 'The diagnostic owner changed.' }
$collect = [scriptblock]::Create($body.Replace($productionPath, $root))
$results = [Collections.Generic.List[string]]::new()
function Check([string]$Name, [string]$Expected, [string]$Prior, [bool]$Denied = $false) {
  $timings = @{ nativeRuntimeFailure = $null }
  $primary = $null
  if ($Prior) { try { throw $Prior } catch { $primary = $_ } }
  if ($Denied) {
    function Get-ItemProperty { throw [UnauthorizedAccessException]::new('denied-test') }
    function Get-ItemPropertyValue { throw [UnauthorizedAccessException]::new('denied-test') }
  }
  . $collect
  $actual = if ($null -eq $primary) { '' } else { $primary.Exception.Message }
  $expectedError = if ($Prior) { $Prior } elseif ($Denied) { 'denied-test' } else { '' }
  if ($actual -cne $expectedError) { throw ('Unexpected primary failure: ' + $Name + ': ' + $actual) }
  $diagnostic = if ($null -eq $timings.nativeRuntimeFailure) { '' } else { $timings.nativeRuntimeFailure.retainedPrimary }
  if ($diagnostic -cne $Expected) { throw ('Unexpected diagnostic: ' + $Name) }
  $results.Add($Name)
}
try {
  Check 'missing key' '' ''
  New-Item -Path $root | Out-Null
  Check 'missing value' '' ''
  Check 'missing value preserves earlier failure' '' 'original-test'
  New-ItemProperty -LiteralPath $root -Name RuntimeMaintenancePrimary -Value 'retained-test' -PropertyType String | Out-Null
  Check 'retained value' 'retained-test' ''
  Check 'retained value preserves earlier failure' 'retained-test' 'original-test'
  Check 'access error remains failure' '' '' $true
  Check 'access error preserves earlier failure' '' 'original-test' $true
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
  if (Test-Path -LiteralPath $root) { throw 'Owned registry fixture remains.' }
}
ConvertTo-Json -InputObject @($results) -Compress
`;
      const result = spawnSync(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: powershellEnvironment({
            NEMOCLAW_ACCEPTANCE_SOURCE: source,
          }),
          encoding: "utf8",
          windowsHide: true,
          // Windows PowerShell 5.1 takes ~29.5s for the real registry matrix on
          // the ARM64 runner and crosses 30s when migration runs in parallel.
          timeout: shell === "powershell.exe" ? 45_000 : 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1)!;
      assert.equal(JSON.parse(lastLine).length, 7);
    },
  );

test(
  "migration accepts retained agents and only versions newer than its published baseline",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
function Parse([string]$File) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw 'Migration controller does not parse.' }
  return $ast
}
$ast=Parse (Join-Path $env:TEST_OWNER 'run-preview-migration.ps1')
$guard=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })[0]
$check=[scriptblock]::Create($ast.ParamBlock.Extent.Text + '; $parsedVersion=$null; ' + $guard.Extent.Text + '; return $NewAgent')
foreach ($agent in @('openclaw','hermes')) {
  foreach ($version in @('0.1.3','0.1.4','0.1.5','0.1.10','bad','0.1.10.1')) {
    $failed=$false
    try { $result=& $check -WorkDirectory 'unused-fixture' -ProductVersion $version -NewAgent $agent } catch { $failed=$true }
    if ($failed -ne ($version -notin @('0.1.5','0.1.10'))) { throw 'Incorrect migration version admission.' }
    if (-not $failed -and $result -cne $agent) { throw 'Incorrect migrated agent.' }
  }
}
$controls=Parse (Join-Path $env:TEST_OWNER 'preview-ui-controls.ps1')
$function=@($controls.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Set-PreviewCanaryConfiguration'},$true))[0]
$parameters=($function.Parameters | ForEach-Object { $_.Extent.Text }) -join ','
$choose=[scriptblock]::Create('param('+ $parameters + ') ' + $function.Body.EndBlock.Statements[0].Extent.Text + '; return $choiceId')
foreach ($entry in @{openclaw='AgentOpenClaw';hermes='AgentHermes'}.GetEnumerator()) {
  if ((& $choose -Window $null -Endpoint '' -Key '' -Agent $entry.Key) -cne $entry.Value) { throw 'Wrong native UI agent choice.' }
}
try { $null=& $choose -Window $null -Endpoint '' -Key '' -Agent 'unrecognized'; throw 'Unexpected agent accepted.' }
catch [System.Management.Automation.ParameterBindingException] { }
Write-Output 'pass'
`;
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: powershellEnvironment({ TEST_OWNER: fileURLToPath(new URL(".", import.meta.url)) }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "pass");
  },
);

test(
  "migration requires tier-specific native preparation evidence",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:MIGRATION_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Migration controller does not parse.' }
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-MigrationPreparationNoop'},$true)
if ($null -eq $function) { throw 'Migration preparation owner is missing.' }
. ([scriptblock]::Create($function.Extent.Text))
$root=Join-Path ([IO.Path]::GetTempPath()) ('migration-preparation-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
function Reject([scriptblock]$Fixture) {
  $failed=$false
  try { & $Fixture } catch { $failed=$true }
  if (-not $failed) { throw 'Invalid migration preparation evidence was accepted.' }
}
try {
  $base=Join-Path $root 'base.log'
  [IO.File]::WriteAllText($base,('prefix MXC preparation tier: base-container'+[Environment]::NewLine))
  $baseResult=Assert-MigrationPreparationNoop $base
  if ($baseResult.tier -cne 'base-container' -or $baseResult.helperSkipped -ne $true -or $baseResult.addedAces -ne 0 -or $baseResult.writeCalls -ne 0 -or $null -ne $baseResult.sidecarSha256) { throw 'BaseContainer preparation result is incomplete.' }

  $app=Join-Path $root 'app.log'; $attempt='a' * 32
  [IO.File]::WriteAllText($app,('prefix MXC preparation tier: appcontainer-dacl'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  $sidecar=$app + '.host-preparation-' + $attempt + '.json'
  @{classification='nemoclaw-host-preparation-diagnostic';operation='prepare-system-drive';status='succeeded';addedAces=0;writeCalls=0;elapsedMilliseconds=7;attemptId=$attempt} | ConvertTo-Json -Compress | Set-Content -LiteralPath $sidecar -NoNewline
  $appResult=Assert-MigrationPreparationNoop $app
  if ($appResult.tier -cne 'appcontainer-dacl' -or $appResult.helperSkipped -ne $false -or $appResult.addedAces -ne 0 -or $appResult.writeCalls -ne 0 -or $appResult.elapsedMilliseconds -ne 7 -or $appResult.sidecarSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'AppContainer preparation result is incomplete.' }

  [IO.File]::WriteAllText((Join-Path $root 'bad-tier.log'),('MXC preparation tier: unsupported'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'bad-tier.log') }
  [IO.File]::WriteAllText((Join-Path $root 'duplicate.log'),('MXC preparation tier: base-container'+[Environment]::NewLine+'MXC preparation tier: base-container'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'duplicate.log') }
  [IO.File]::WriteAllText((Join-Path $root 'base-helper.log'),('MXC preparation tier: base-container'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'base-helper.log') }
  [IO.File]::WriteAllText((Join-Path $root 'missing-sidecar.log'),('MXC preparation tier: appcontainer-dacl'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'missing-sidecar.log') }
  [IO.File]::WriteAllText((Join-Path $root 'oversized.log'),('x' * 1048577))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'oversized.log') }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Output 'pass'
`;
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: powershellEnvironment({
          MIGRATION_SOURCE: fileURLToPath(new URL("run-preview-migration.ps1", import.meta.url)),
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "pass");
  },
);
