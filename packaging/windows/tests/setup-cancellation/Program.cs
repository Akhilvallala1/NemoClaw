// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class Program
{
    private const string ValidPreparation = "{\"schemaVersion\":1,\"inference\":null,\"services\":{},\"localModel\":{}}";

    private static NativeSetupConfiguration LocalConfiguration() =>
        new("openclaw", "local", null, NativeExpressSetup.Model, false) { LocalModel = NativeExpressSetup.Id };

    private static void ResetFixtureState()
    {
        NativeExpressSetup.ValidationCalls = 0;
        NativeDesktopIntegration.EnsureCalls = 0;
        NativeDownloadedModelSetup.Ready = null;
    }

    private static async Task AssertPrecancelledSaveDoesNotLaunchAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var invocations = 0;
        var phases = new List<string>();
        Task<string> UnexpectedHelper(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations++;
            return Task.FromResult(ValidPreparation);
        }
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(
                LocalConfiguration(), password, null, progress => phases.Add(progress.Phase), cancellation.Token,
                "unused-test-launcher", UnexpectedHelper);
            throw new InvalidOperationException("A pre-cancelled native setup save was accepted.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        if (invocations != 0 || phases.Count != 0 || NativeExpressSetup.ValidationCalls != 0 || NativeDesktopIntegration.EnsureCalls != 0)
            throw new InvalidOperationException("A pre-cancelled native setup save crossed its launch checkpoint.");
    }

    private static async Task AssertCancellationAfterSuccessfulPreparationStopsMutationAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        var invocations = 0;
        var phases = new List<string>();
        Task<string> CancelAfterPreparation(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations++;
            cancellation.Cancel();
            return Task.FromResult(ValidPreparation);
        }
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(
                LocalConfiguration(), password, null, progress => phases.Add(progress.Phase), cancellation.Token,
                "unused-test-launcher", CancelAfterPreparation);
            throw new InvalidOperationException("Cancellation after successful preparation crossed the mutation boundary.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        if (invocations != 1 || !phases.SequenceEqual(new[] { "verification" }) ||
            NativeExpressSetup.ValidationCalls != 1 || NativeDesktopIntegration.EnsureCalls != 0)
            throw new InvalidOperationException("Cancellation after successful preparation launched a mutation or skipped valid preparation parsing.");
    }

    private static async Task AssertCancellationDuringCommitTransitionStopsMutationAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        var invocations = 0;
        var phases = new List<string>();
        Task<string> PrepareOnly(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations++;
            if (invocations != 1) throw new InvalidOperationException("Cancellation during the commit transition launched a mutation helper.");
            return Task.FromResult(ValidPreparation);
        }
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(
                LocalConfiguration(), password, null,
                progress =>
                {
                    phases.Add(progress.Phase);
                    if (progress.Phase == "configuration") cancellation.Cancel();
                },
                cancellation.Token, "unused-test-launcher", PrepareOnly);
            throw new InvalidOperationException("Cancellation during the commit transition was accepted.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        if (invocations != 1 || !phases.SequenceEqual(new[] { "verification", "configuration" }) ||
            NativeExpressSetup.ValidationCalls != 1 || NativeDesktopIntegration.EnsureCalls != 0)
            throw new InvalidOperationException("Cancellation during the commit transition crossed the mutation boundary.");
    }

    private static async Task AssertSuccessfulOrderingAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        var phases = new List<string>();
        var invocations = new List<(string[] Arguments, bool CaptureOutput, string[] Phases)>();
        Task<string> RecordHelper(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations.Add((arguments, captureOutput, phases.ToArray()));
            return Task.FromResult(invocations.Count == 1 ? ValidPreparation : string.Empty);
        }
        await NativeSetupOperations.SaveWithHelperAsync(
            LocalConfiguration(), password, null, progress => phases.Add(progress.Phase), CancellationToken.None,
            "unused-test-launcher", RecordHelper);
        if (invocations.Count != 2 ||
            !invocations[0].Arguments.SequenceEqual(new[] { "--configure-native", "--prepare-all" }) ||
            !invocations[0].CaptureOutput || !invocations[0].Phases.SequenceEqual(new[] { "verification" }) ||
            !invocations[1].Arguments.SequenceEqual(new[] { "--configure-native", "--transaction" }) ||
            invocations[1].CaptureOutput || !invocations[1].Phases.SequenceEqual(new[] { "verification", "configuration" }) ||
            NativeExpressSetup.ValidationCalls != 1 || NativeDesktopIntegration.EnsureCalls != 1)
            throw new InvalidOperationException("The native setup preparation and configuration commit phases are out of order.");
    }

    private static async Task AssertCancellationIsDeferredUntilPreparationFinishesAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        var preparationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releasePreparation = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var invocations = 0;
        var phases = new List<string>();
        async Task<string> DelayedPreparation(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations++;
            preparationStarted.TrySetResult();
            return await releasePreparation.Task;
        }
        var save = NativeSetupOperations.SaveWithHelperAsync(
            LocalConfiguration(), password, null, progress => phases.Add(progress.Phase), cancellation.Token,
            "unused-test-launcher", DelayedPreparation);
        await preparationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Task.Delay(TimeSpan.FromMilliseconds(100));
        var completedBeforePreparation = save.IsCompleted;
        releasePreparation.TrySetResult(ValidPreparation);
        try
        {
            await save.WaitAsync(TimeSpan.FromSeconds(5));
            throw new InvalidOperationException("Deferred native setup cancellation was accepted after preparation.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        if (completedBeforePreparation || invocations != 1 || !phases.SequenceEqual(new[] { "verification" }) ||
            NativeExpressSetup.ValidationCalls != 1 || NativeDesktopIntegration.EnsureCalls != 0)
            throw new InvalidOperationException("Native setup cancellation interrupted preparation instead of waiting for its safe checkpoint.");
    }

    private static async Task AssertCredentialTransactionAsync(bool fail)
    {
        ResetFixtureState();
        const string secret = "nvapi-test-only-transaction-key";
        using var password = new System.Security.SecureString();
        foreach (var character in secret) password.AppendChar(character);
        var configuration = new NativeSetupConfiguration("hermes", "nvidia", "https://integrate.api.nvidia.com/v1", "test-model", true);
        var calls = 0;
        byte[]? transaction = null;
        Task<string> Helper(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            calls++;
            if (calls == 1)
            {
                if (System.Text.Encoding.UTF8.GetString(input).Contains(secret, StringComparison.Ordinal))
                    throw new InvalidOperationException("Preparation received a secret.");
                return Task.FromResult("{\"schemaVersion\":1,\"inference\":\"" + new string('a', 64) + "\",\"services\":{}}");
            }
            if (calls != 2 || captureOutput || !arguments.SequenceEqual(new[] { "--configure-native", "--transaction" }))
                throw new InvalidOperationException("Credential mutations escaped the configuration transaction.");
            transaction = input;
            using var document = JsonDocument.Parse(input);
            if (document.RootElement.GetProperty("credentials").GetProperty("inference").GetString() != secret ||
                document.RootElement.GetProperty("configuration").GetRawText().Contains(secret, StringComparison.Ordinal))
                throw new InvalidOperationException("The private transaction envelope is invalid.");
            if (fail) throw new IOException("Simulated owner failure.");
            return Task.FromResult(string.Empty);
        }
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(configuration, password, null, null, CancellationToken.None, "unused-test-launcher", Helper);
            if (fail) throw new InvalidOperationException("A failed transaction was accepted.");
        }
        catch (IOException) when (fail) { }
        if (calls != 2 || transaction is null || transaction.Any(value => value != 0) ||
            NativeDesktopIntegration.EnsureCalls != (fail ? 0 : 1))
            throw new InvalidOperationException("Transaction cleanup or success publication failed.");
    }

    private static async Task AssertDownloadedModelOrderingAsync(bool cancel, bool failCommit)
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        var configuration = new NativeSetupConfiguration("openclaw", "local", null, "fixture-downloaded-model", false) { LocalModel = "fixture-downloaded-model" };
        var calls = 0;
        var readyCalls = 0;
        byte[]? transaction = null;
        Task<string> Helper(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            calls++;
            if (calls == 1) return Task.FromResult(ValidPreparation);
            if (calls != 2 || !arguments.SequenceEqual(new[] { "--configure-native", "--transaction" }))
                throw new InvalidOperationException("Downloaded model setup escaped the credential transaction.");
            transaction = input;
            if (failCommit) throw new IOException("Fixture commit failed.");
            return Task.FromResult(string.Empty);
        }
        NativeDownloadedModelSetup.Ready = token =>
        {
            readyCalls++;
            if (calls != 2 || transaction is null || transaction.Any(value => value != 0) || NativeDesktopIntegration.EnsureCalls != 1)
                throw new InvalidOperationException("Model readiness started before commit and secret-buffer cleanup.");
            if (cancel) cancellation.Cancel();
            token.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        };
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(configuration, password, null, null, cancellation.Token, "unused", Helper);
            if (cancel || failCommit) throw new InvalidOperationException("A failed model setup was reported as success.");
        }
        catch (OperationCanceledException) when (cancel && cancellation.IsCancellationRequested) { }
        catch (IOException) when (failCommit) { }
        if (readyCalls != (failCommit ? 0 : 1) || transaction is null || transaction.Any(value => value != 0))
            throw new InvalidOperationException("Downloaded model setup did not preserve the commit boundary.");
    }

    private static void AssertRecoverableMaintenanceCancellationCanRetry()
    {
        var cancellation = new NativeCancellationState();
        using var firstAttempt = new CancellationTokenSource();
        cancellation.Request(firstAttempt);
        if (!cancellation.IsRequested || !firstAttempt.IsCancellationRequested)
            throw new InvalidOperationException("The first maintenance cancellation was not delivered.");

        cancellation.ResetForRetry();
        using var retry = new CancellationTokenSource();
        if (cancellation.IsRequested || retry.IsCancellationRequested)
            throw new InvalidOperationException("A recoverable maintenance cancellation leaked into its retry.");

        cancellation.Request(retry);
        if (!cancellation.IsRequested || !retry.IsCancellationRequested)
            throw new InvalidOperationException("The retried maintenance attempt could not be cancelled independently.");
    }

    private static string ProductionMethod(string source, string start, string end)
    {
        var startIndex = source.IndexOf(start, StringComparison.Ordinal);
        if (startIndex < 0)
            throw new InvalidOperationException($"The production cancellation fixture could not locate {start}.");
        var endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        if (endIndex < 0)
            throw new InvalidOperationException($"The production cancellation fixture could not locate {start}.");
        return source[startIndex..endIndex];
    }

    private static string RepositoryRoot()
    {
        foreach (var candidate in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (var directory = new DirectoryInfo(candidate); directory is not null; directory = directory.Parent)
            {
                if (File.Exists(Path.Combine(directory.FullName, "package.json")) &&
                    File.Exists(Path.Combine(directory.FullName, "packaging", "windows", "bootstrapper", "MainWindow.xaml.cs")))
                    return directory.FullName;
            }
        }
        throw new InvalidOperationException("The production cancellation fixture could not locate the repository root.");
    }

    private static void AssertRecoverableMaintenanceProductionWiring()
    {
        var bootstrapperRoot = Path.Combine(RepositoryRoot(), "packaging", "windows", "bootstrapper");
        var application = File.ReadAllText(Path.Combine(bootstrapperRoot, "NemoClawBootstrapperApplication.cs"));
        var beginMaintenance = ProductionMethod(application, "private async Task BeginMaintenanceAsync", "private async Task ReplacePreviousPreviewAsync");
        var replacePreview = ProductionMethod(application, "private async Task ReplacePreviousPreviewAsync", "private void ShowRecoverableMaintenanceError");
        const string recover = "this.ShowRecoverableMaintenanceError(error);";
        if (!beginMaintenance.Contains(recover, StringComparison.Ordinal) ||
            !replacePreview.Contains(recover, StringComparison.Ordinal))
            throw new InvalidOperationException("A recoverable maintenance catch no longer clears cancellation before retry.");

        var recovery = ProductionMethod(application, "private void ShowRecoverableMaintenanceError", "private async Task PrepareHeadlessMaintenanceAsync");
        var resetIndex = recovery.IndexOf("this.cancellation.ResetForRetry();", StringComparison.Ordinal);
        var maintenanceIndex = recovery.IndexOf("this.window?.ShowMaintenance();", StringComparison.Ordinal);
        var pendingIndex = recovery.IndexOf("error is NativeMaintenance.RelatedActionPendingException", StringComparison.Ordinal);
        var closeOnlyIndex = recovery.IndexOf("this.window?.ShowFailure(error.Message, this.BundleLogPath());", StringComparison.Ordinal);
        var returnIndex = recovery.IndexOf("return;", StringComparison.Ordinal);
        if (pendingIndex < 0 || closeOnlyIndex <= pendingIndex || returnIndex <= closeOnlyIndex || resetIndex <= returnIndex)
            throw new InvalidOperationException("Unconfirmed Windows Installer completion must take the close-only path before any retry state is reset.");
        if (resetIndex < 0 || maintenanceIndex < resetIndex)
            throw new InvalidOperationException("The recoverable maintenance path no longer resets cancellation before restoring maintenance UI.");

        var window = File.ReadAllText(Path.Combine(bootstrapperRoot, "MainWindow.xaml.cs"));
        var showMaintenance = ProductionMethod(window, "public void ShowMaintenance()", "public void ShowProgress(");
        if (!showMaintenance.Contains("this.cancellation.ResetForRetry();", StringComparison.Ordinal))
            throw new InvalidOperationException("The maintenance UI no longer clears its cancellation latch for retry.");
    }

    private static async Task<int> RunHelperFixtureAsync(string[] arguments)
    {
        var root = arguments[1];
        var exitCode = int.Parse(arguments[2]);
        var outputSize = int.Parse(arguments[3]);
        _ = await Console.In.ReadToEndAsync();
        using var lease = new FileStream(Path.Combine(root, "lease"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        await File.WriteAllTextAsync(Path.Combine(root, "ready"), Environment.ProcessId.ToString());
        await Console.Out.WriteAsync(new string('x', outputSize));
        await Console.Error.WriteAsync(new string('y', outputSize));
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while (!File.Exists(Path.Combine(root, "release"))) await Task.Delay(20, limit.Token);
        await File.WriteAllTextAsync(Path.Combine(root, "result"), exitCode == 0 ? "committed" : "recovered");
        return exitCode;
    }

    private static async Task AssertTransactionOutlivesObserverAsync(int exitCode, int outputSize, bool observerThrows = false)
    {
        var root = Directory.CreateTempSubdirectory("nemoclaw-setup-owner-").FullName;
        var notified = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var launcher = Environment.ProcessPath ?? throw new InvalidOperationException("The fixture executable is unavailable.");
        var arguments = new List<string>();
        if (Path.GetFileNameWithoutExtension(launcher).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            arguments.Add(typeof(Program).Assembly.Location);
        arguments.AddRange(new[] { "--helper-fixture", root, exitCode.ToString(), outputSize.ToString(), "--transaction" });
        void Pending()
        {
            notified.SetResult();
            if (observerThrows) throw new InvalidOperationException("fixture observer failed");
        }
        var operation = NativeSetupOperations.RunSetupHelperAsync(launcher, arguments.ToArray(), Array.Empty<byte>(),
            waitingForTransaction: Pending, observationDeadline: TimeSpan.FromMilliseconds(50));
        try
        {
            await notified.Task.WaitAsync(TimeSpan.FromSeconds(10));
            using var readyLimit = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (!File.Exists(Path.Combine(root, "ready"))) await Task.Delay(20, readyLimit.Token);
            if (operation.IsCompleted || File.Exists(Path.Combine(root, "result")))
                throw new InvalidOperationException("Setup returned before the transaction owner finished.");
            try
            {
                using var lease = new FileStream(Path.Combine(root, "lease"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                throw new InvalidOperationException("The observer deadline released the transaction owner's lease.");
            }
            catch (IOException) { }
            await File.WriteAllTextAsync(Path.Combine(root, "release"), "finish");
            Exception? failure = null;
            try { await operation.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (InvalidOperationException error) { failure = error; }
            if ((failure is not null) != (exitCode != 0 || outputSize != 0 || observerThrows))
                throw new InvalidOperationException("Setup misclassified the completed helper result.");
            if (await File.ReadAllTextAsync(Path.Combine(root, "result")) != (exitCode == 0 ? "committed" : "recovered"))
                throw new InvalidOperationException("The transaction did not finish its commit or recovery fixture.");
            using var releasedLease = new FileStream(Path.Combine(root, "lease"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }
        finally
        {
            await File.WriteAllTextAsync(Path.Combine(root, "release"), "finish");
            try { await operation.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (InvalidOperationException) { }
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task AssertPreparationTimeoutStopsHelperAsync()
    {
        var root = Directory.CreateTempSubdirectory("nemoclaw-setup-prepare-").FullName;
        var launcher = Environment.ProcessPath ?? throw new InvalidOperationException("The fixture executable is unavailable.");
        var arguments = new List<string>();
        if (Path.GetFileNameWithoutExtension(launcher).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            arguments.Add(typeof(Program).Assembly.Location);
        arguments.AddRange(new[] { "--helper-fixture", root, "0", "0", "--prepare-all" });
        var operation = NativeSetupOperations.RunSetupHelperAsync(launcher, arguments.ToArray(), Array.Empty<byte>(),
            captureOutput: true, observationDeadline: TimeSpan.FromSeconds(1));
        try
        {
            try
            {
                await operation.WaitAsync(TimeSpan.FromSeconds(10));
                throw new InvalidOperationException("The read-only preparation deadline was ignored.");
            }
            catch (OperationCanceledException) { }
            if (File.Exists(Path.Combine(root, "result")))
                throw new InvalidOperationException("The timed-out preparation helper completed unexpectedly.");
            using var releasedLease = new FileStream(Path.Combine(root, "lease"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        finally
        {
            await File.WriteAllTextAsync(Path.Combine(root, "release"), "finish");
            try { await operation.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (OperationCanceledException) { }
            Directory.Delete(root, recursive: true);
        }
    }

    internal static async Task<int> Main(string[] arguments)
    {
        if (arguments.FirstOrDefault() == "--helper-fixture") return await RunHelperFixtureAsync(arguments);
        await AssertPrecancelledSaveDoesNotLaunchAsync();
        await AssertCancellationAfterSuccessfulPreparationStopsMutationAsync();
        await AssertCancellationDuringCommitTransitionStopsMutationAsync();
        await AssertSuccessfulOrderingAsync();
        await AssertCancellationIsDeferredUntilPreparationFinishesAsync();
        await AssertCredentialTransactionAsync(false);
        await AssertCredentialTransactionAsync(true);
        await AssertDownloadedModelOrderingAsync(false, false);
        await AssertDownloadedModelOrderingAsync(true, false);
        await AssertDownloadedModelOrderingAsync(false, true);
        AssertRecoverableMaintenanceCancellationCanRetry();
        AssertRecoverableMaintenanceProductionWiring();
        await AssertTransactionOutlivesObserverAsync(0, 0);
        await AssertTransactionOutlivesObserverAsync(7, 0);
        await AssertTransactionOutlivesObserverAsync(0, 1);
        await AssertTransactionOutlivesObserverAsync(0, 65536);
        await AssertTransactionOutlivesObserverAsync(0, 0, observerThrows: true);
        await AssertPreparationTimeoutStopsHelperAsync();
        Console.WriteLine("18 native setup controls passed; observer deadlines preserve transaction ownership through exit.");
        return 0;
    }
}

internal sealed record NativeExpressProgress(string Phase, string Message, long? CompletedBytes, long? TotalBytes);

internal static class NativeExpressSetup
{
    internal static string Id => "unused-test-model";
    internal static string Model => "unused-test-model";
    internal static int ValidationCalls { get; set; }

    internal static void ValidatePrebuiltSelection(JsonElement preparation, string selected)
    {
        ValidationCalls++;
        if (selected != Id || !preparation.TryGetProperty("localModel", out var model) || model.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("The cancellation fixture received invalid prebuilt-model metadata.");
    }
}

internal static class NativeMaintenance
{
    internal static bool SupportsDataRemoval() => throw new InvalidOperationException("Unexpected maintenance invocation in the cancellation fixture.");
}

internal static class NativeDownloadedModelSetup
{
    internal static Func<CancellationToken, Task>? Ready { get; set; }
    internal static bool IsModel(string? id) => id == "fixture-downloaded-model";
    internal static void ValidateSelection(JsonElement preparation, string selected)
    {
        if (!IsModel(selected) || !preparation.TryGetProperty("localModel", out var model) || model.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("Invalid downloaded-model fixture metadata.");
    }
    internal static Task EnsureReadyAsync(string launcher, string selected, Action<NativeExpressProgress>? progress, CancellationToken cancellation) =>
        (Ready ?? throw new InvalidOperationException("Unexpected model readiness invocation."))(cancellation);
}

internal static class NativeDesktopIntegration
{
    internal static int EnsureCalls { get; set; }
    internal static void Ensure(string agent, string launcher) => EnsureCalls++;
}
