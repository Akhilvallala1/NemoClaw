// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("actual builder cabinet transaction releases only owned mappings and retains independent cleanup errors", () => {
  const source = readFileSync(new URL("./build-immutable-package.ps1", import.meta.url));
  const script = String.raw`
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$source=[Console]::In.ReadToEnd()
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Builder syntax invalid.' }
$block=$ast.FindAll({param($node) $node -is [Management.Automation.Language.TryStatementAst] -and $node.Extent.Text.Contains('$cabinetMapped = $LASTEXITCODE -eq 0')},$true) | Sort-Object {$_.Extent.Text.Length} | Select-Object -First 1
if (-not $block) { throw 'Cabinet transaction missing.' }
$transaction=[scriptblock]::Create($block.Extent.Text + [Environment]::NewLine + 'if ($null -ne $cabinetFailure) { throw $cabinetFailure }')
function Require($condition,$message) { if (-not $condition) { throw $message } }
function Invoke-TestSubst([string]$drive,[string]$target) {
    $global:state.calls.Add("$drive $target"); $global:LASTEXITCODE=0
    if ($target -eq '/D') {
        if ($global:state.releaseThrows -eq $drive) { throw 'fixture-release-launch-error' }
        if ($global:state.releaseFailures -contains $drive) { $global:LASTEXITCODE=1 }
    } elseif ($global:state.acquireFailure -eq $drive) { $global:LASTEXITCODE=1 }
}
function Test-Path([string]$LiteralPath,[string]$PathType) {
    if ($LiteralPath.EndsWith('immutable-package-inputs.json')) { return -not $global:state.payloadMissing }
    if ($LiteralPath.EndsWith('runtime.manifest')) { return -not $global:state.runtimeMissing }
    throw 'Unexpected filesystem probe.'
}
function Invoke-BuildTool([string]$Executable,[string[]]$Arguments,[string]$Label) {
    $global:state.calls.Add($Label)
    if ($global:state.buildFailure) { throw 'fixture-primary-build-error' }
}
$cases=@(
    @{name='success';releases=@('R: /D','P: /D')},
    @{name='image';image=$true;releases=@('P: /D')},
    @{name='payload-validation';payloadMissing=$true;error='cabinet source drive could not be bound';releases=@('P: /D')},
    @{name='failed-first-acquire';acquireFailure='P:';error='cabinet source drive could not be bound';releases=@()},
    @{name='failed-second-acquire';acquireFailure='R:';error='runtime cabinet drive could not be bound';releases=@('P: /D')},
    @{name='runtime-validation';runtimeMissing=$true;error='runtime cabinet drive could not be bound';releases=@('R: /D','P: /D')},
    @{name='build-failure';buildFailure=$true;error='fixture-primary-build-error';releases=@('R: /D','P: /D')},
    @{name='runtime-release';releaseFailures=@('R:');error='runtime cabinet drive could not be released';cleanup=@('R:');releases=@('R: /D','P: /D')},
    @{name='payload-release';releaseFailures=@('P:');error='cabinet source drive could not be released';cleanup=@('P:');releases=@('R: /D','P: /D')},
    @{name='both-release';releaseFailures=@('R:','P:');error='runtime cabinet drive could not be released';cleanup=@('R:','P:');releases=@('R: /D','P: /D')},
    @{name='primary-and-cleanup';buildFailure=$true;releaseFailures=@('R:','P:');error='fixture-primary-build-error';cleanup=@('R:','P:');releases=@('R: /D','P: /D')},
    @{name='release-launch-throws';releaseThrows='R:';error='runtime cabinet drive could not be released';cleanup=@('R:');releases=@('R: /D','P: /D')}
)
foreach ($case in $cases) {
    $global:state=@{calls=[Collections.Generic.List[string]]::new();payloadMissing=$false;runtimeMissing=$false;acquireFailure='';releaseFailures=@();releaseThrows='';buildFailure=$false}
    foreach ($key in @('payloadMissing','runtimeMissing','acquireFailure','releaseFailures','releaseThrows','buildFailure')) {
        if ($case.ContainsKey($key)) { $global:state[$key]=$case[$key] }
    }
    $subst='Invoke-TestSubst';$cabinetDrive='P:';$runtimeDrive='R:'
    $fixtureRoot=[IO.Path]::GetTempPath()
    $cabinetRoot=Join-Path $fixtureRoot 'fixture-payload';$runtimeCabinetRoot=Join-Path $fixtureRoot 'fixture-runtime';$payload=Join-Path $fixtureRoot 'fixture-source'
    $owner=$fixtureRoot;$windows=$fixtureRoot;$composer=Join-Path $fixtureRoot 'fixture-composer.py'
    $payloadAuthoring=Join-Path $fixtureRoot 'fixture.wxs';$transactions=Join-Path $fixtureRoot 'fixture.wxi';$helper=Join-Path $fixtureRoot 'fixture.exe';$msi=Join-Path $fixtureRoot 'fixture.msi'
    $SourceRoot=$payload;$PythonPath='unused-python';$WixPath='unused-wix';$ProductVersion='0.1.10'
    $assembly=@{runtime=@{runtimeId='fixture'}};$imageDelivery=$case.ContainsKey('image')
    $receipt=@{};$cabinetFailure=$null;$cabinetMapped=$false;$runtimeMapped=$false
    $cabinetCleanupErrors=[Collections.Generic.List[object]]::new();$failure=$null
    try { & $transaction } catch { $failure=$_.Exception.Message }
    if ($case.ContainsKey('error')) { Require ($failure -and $failure.Contains($case.error)) ($case.name+': wrong primary error: '+$failure) }
    else { Require ($null -eq $failure) ($case.name+': unexpected failure: '+$failure) }
    $released=@($global:state.calls | Where-Object {$_.EndsWith(' /D')})
    Require (($released -join '|') -ceq ($case.releases -join '|')) ($case.name+': wrong releases')
    $expectedCleanup=if($case.ContainsKey('cleanup')){$case.cleanup}else{@()}
    $actualCleanup=@($receipt.cabinetCleanupErrors | ForEach-Object {$_.drive})
    Require (($actualCleanup -join '|') -ceq ($expectedCleanup -join '|')) ($case.name+': cleanup receipt lost')
    $raw=$receipt|ConvertTo-Json -Depth 4
    Require (-not $raw.Contains('fixture-release-launch-error')) 'Raw cleanup error must not replace bounded diagnostic.'
    Write-Output ('PASS '+$case.name)
}
`;
  const result = spawnSync(
    process.env.NEMOCLAW_TEST_PWSH ?? "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: source,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.split(/\r?\n/u).filter((line) => line.startsWith("PASS ")).length, 12);
});
