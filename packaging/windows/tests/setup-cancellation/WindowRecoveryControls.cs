// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#if NATIVE_WPF_CONTROLS
extern alias NativeBootstrapper;

using System.Reflection;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MainWindow = NativeBootstrapper::Nvidia.NemoClaw.Bootstrapper.MainWindow;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class WindowRecoveryControls
{
    private static bool HasRenderedContent(byte[] pixels, int width, int height)
    {
        var colors = new HashSet<int>();
        var visiblePixels = 0;
        for (var y = 8; y < height - 8; y++)
            for (var x = 8; x < width - 8; x++)
            {
                var offset = (y * width + x) * 4;
                if (pixels[offset + 3] == 0) continue;
                visiblePixels++;
                colors.Add(pixels[offset] | pixels[offset + 1] << 8 | pixels[offset + 2] << 16);
                if (visiblePixels >= 1000 && colors.Count >= 2) return true;
            }
        return false;
    }

    private static void AssertPixelGuard()
    {
        const int size = 64;
        var pixels = new byte[size * size * 4];
        if (HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("A transparent frame satisfied presentation evidence.");
        for (var index = 0; index < pixels.Length; index += 4) pixels[index + 3] = 255;
        if (HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("An opaque single-color frame satisfied presentation evidence.");
        for (var y = 0; y < size; y++)
            for (var x = 0; x < 8; x++) pixels[(y * size + x) * 4] = 255;
        if (HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("A border-only frame satisfied presentation evidence.");
        for (var y = 8; y < size - 8; y++)
            for (var x = 8; x < size / 2; x++) pixels[(y * size + x) * 4] = 255;
        if (!HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("The pixel guard rejected visible high-contrast content.");
        for (var index = 0; index < pixels.Length; index += 4) pixels[index + 3] = 0;
        if (HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("Invisible RGB values satisfied presentation evidence.");
    }

    private static object? Invoke(MainWindow window, string method, params object[] arguments) =>
        (typeof(MainWindow).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException($"Missing Setup operation: {method}."))
        .Invoke(window, arguments);

    private static void AssertCompletionPresentation(MainWindow window)
    {
        var detail = (TextBlock)window.FindName("SuccessDetail");
        window.ShowSuccess(WixToolset.BootstrapperApplicationApi.LaunchAction.Uninstall);
        if (!detail.Text.Contains("Your agent data and saved keys were kept.", StringComparison.Ordinal))
            throw new InvalidOperationException("Default uninstall did not report preserved agent data and keys.");
        var removal = (UserControl)window.FindName("RemovalOptions");
        ((CheckBox)removal.FindName("RemoveData")).IsChecked = true;
        var agents = (Panel)removal.FindName("Agents");
        agents.Children.OfType<CheckBox>().Single(value => value.Tag as string == "openclaw").IsChecked = true;
        window.ShowSuccess(WixToolset.BootstrapperApplicationApi.LaunchAction.Uninstall);
        if (!detail.Text.Contains("OpenClaw data and saved keys were removed.", StringComparison.Ordinal)
            || !detail.Text.Contains("Other agent data and shared local models were kept.", StringComparison.Ordinal))
            throw new InvalidOperationException("Selective uninstall reported that removed OpenClaw data was retained.");
        ((CheckBox)removal.FindName("RemoveData")).IsChecked = false;

        var availability = typeof(MainWindow).GetField("runtimeAvailability", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var original = availability.GetValue(window);
        var parse = availability.FieldType.GetMethod("Parse", BindingFlags.Static | BindingFlags.NonPublic)!;
        try
        {
            foreach (var status in new[] { "unqualified", "not-included", "qualified" })
            {
                var record = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
                {
                    schemaVersion = 1,
                    classification = "native-runtime-package-availability",
                    runtimeId = new string('a', 64),
                    manifestSha256 = new string('b', 64),
                    sourceRevision = new string('c', 40),
                    agents = new[] { new { agent = "openclaw", status }, new { agent = "hermes", status = "not-included" } },
                });
                availability.SetValue(window, parse.Invoke(null, new object[] { record }));
                Invoke(window, "ApplyRuntimeAvailability");
                Invoke(window, "ShowNativeOnboarding", "openclaw");
                var enabled = status == "qualified";
                var expected = status == "unqualified" ? "Unavailable: runtime qualification is pending." : "Unavailable in this preview";
                if ((!enabled && ((TextBlock)window.FindName("AgentAvailabilityDetail")).Text != expected)
                    || ((Button)window.FindName("ContinueAgentButton")).IsEnabled != enabled
                    || ((RadioButton)window.FindName("OpenClawChoice")).IsEnabled != enabled)
                    throw new InvalidOperationException("Onboarding lost the OpenClaw availability reason or enabled an unqualified runtime.");
            }
        }
        finally { availability.SetValue(window, original); Invoke(window, "ApplyRuntimeAvailability"); }
    }

    private static void AssertProviderChoices(MainWindow window)
    {
        var providers = (ComboBox)window.FindName("ProviderChoice");
        var endpoint = (TextBox)window.FindName("EndpointBox");
        var model = (TextBox)window.FindName("ModelBox");
        var credential = (PasswordBox)window.FindName("CredentialBox");
        ComboBoxItem Provider(string id) => providers.Items.OfType<ComboBoxItem>().Single(value => value.Tag as string == id);
        providers.SelectedItem = Provider("nvidia");
        model.Text = "chosen-hosted-model";
        credential.Password = "nvapi-ui-fixture-only";
        providers.SelectedItem = Provider("compatible");
        if (credential.SecurePassword.Length != 0)
            throw new InvalidOperationException("Provider changes retained a previous provider's API key.");
        endpoint.Text = "https://example.invalid/custom/v1";
        model.Text = "chosen-compatible-model";
        providers.SelectedItem = Provider("local");
        endpoint.Text = "http://127.0.0.1:12345/v1";
        model.Text = "chosen-local-model";
        providers.SelectedItem = Provider("compatible");
        if (endpoint.Text != "https://example.invalid/custom/v1" || model.Text != "chosen-compatible-model")
            throw new InvalidOperationException("Switching back to compatible inference lost the chosen endpoint or model.");
        providers.SelectedItem = Provider("nvidia");
        if (model.Text != "chosen-hosted-model" || endpoint.Text != "https://integrate.api.nvidia.com/v1"
            || credential.SecurePassword.Length != 0 || !endpoint.IsReadOnly)
            throw new InvalidOperationException("Switching back to hosted inference lost the model or changed credential/endpoint rules.");
        providers.SelectedItem = Provider("local");
        if (endpoint.Text != "http://127.0.0.1:12345/v1" || model.Text != "chosen-local-model")
            throw new InvalidOperationException("Switching back to local inference lost the chosen endpoint or model.");

        Invoke(window, "AgentSelected", new RadioButton { Tag = "hermes" }, new RoutedEventArgs());
        endpoint.Text = "http://127.0.0.1:23456/v1";
        model.Text = "other-agent-local-model";
        credential.Password = "other-agent-ui-fixture-only";
        Invoke(window, "AgentSelected", new RadioButton { Tag = "openclaw" }, new RoutedEventArgs());
        if (endpoint.Text != "http://127.0.0.1:12345/v1" || model.Text != "chosen-local-model"
            || credential.SecurePassword.Length != 0)
            throw new InvalidOperationException("Another agent changed OpenClaw's draft choices or retained its API key.");

        providers.SelectedItem = Provider("openrouter");
        model.Text = "chosen-openrouter-model";
        credential.Password = "sk-or-ui-fixture-only";
        providers.SelectedItem = Provider("local");
        providers.SelectedItem = Provider("openrouter");
        if (model.Text != "chosen-openrouter-model" || endpoint.Text != "https://openrouter.ai/api/v1"
            || credential.SecurePassword.Length != 0 || !endpoint.IsReadOnly)
            throw new InvalidOperationException("OpenRouter lost its chosen model or changed credential/endpoint rules.");

        var managed = new ComboBoxItem { Tag = "n1x", Content = "Fixture managed model" };
        providers.Items.Add(managed);
        providers.SelectedItem = managed;
        var managedModel = model.Text;
        model.Text = "must-not-restore-this-managed-draft";
        providers.SelectedItem = Provider("local");
        providers.SelectedItem = managed;
        if (model.Text != managedModel || !model.IsReadOnly || !endpoint.IsReadOnly
            || endpoint.Visibility != Visibility.Collapsed || credential.Visibility != Visibility.Collapsed)
            throw new InvalidOperationException("A managed model restored editable draft values or exposed endpoint/key fields.");
        providers.SelectedItem = Provider("local");
        if (endpoint.Text != "http://127.0.0.1:12345/v1" || model.Text != "chosen-local-model")
            throw new InvalidOperationException("Managed inference changed the existing local-server choices.");
        providers.Items.Remove(managed);
    }

    private static void AssertSavedOutputBounds()
    {
        var operations = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NativeSetupOperations")!;
        var read = operations.GetMethod("ReadBoundedOutputAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        foreach (var (length, maximum, drain) in new[] { (5000, 16384, false), (16384, 16384, false), (16385, 16384, false), (4097, 4096, false), (8192, 4096, true) })
        {
            using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(new string('x', length)));
            using var reader = new StreamReader(stream);
            var operation = (Task<(int Count, string Value)>)read.Invoke(null, new object[] { reader, CancellationToken.None, true, drain, maximum })!;
            try
            {
                var result = operation.GetAwaiter().GetResult();
                if (length > maximum || result.Count != length || result.Value.Length != length)
                    throw new InvalidOperationException("Saved-settings output violated its selected bound.");
            }
            catch (InvalidOperationException error) when (error.Message == "The native setup helper exceeded its output bound.")
            {
                if (length <= maximum || drain && stream.Position != stream.Length)
                    throw new InvalidOperationException("Overflow stopped transaction draining or rejected valid metadata.");
            }
        }
        var helper = operations.GetMethod("RunSetupHelperAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        foreach (var (arguments, capture, maximum) in new[] {
            (new[] { "--prepare-all" }, true, 16384), (new[] { "--recovery-status", "openclaw" }, true, 16384),
            (new[] { "--read-settings", "openclaw" }, false, 16384), (new[] { "--read-settings", "--transaction" }, true, 16384),
            (new[] { "--read-settings", "openclaw" }, true, 16385), (new[] { "--read-settings", "openclaw" }, true, 4095),
        })
        {
            var operation = (Task<string>)helper.Invoke(null, new object?[] { "must-not-start", arguments, Array.Empty<byte>(), capture, null, null, null, null, maximum })!;
            try { operation.GetAwaiter().GetResult(); throw new InvalidOperationException("An unrelated helper received the larger settings bound."); }
            catch (ArgumentOutOfRangeException) { }
        }
    }

    private static void AssertSavedChoices(MainWindow window)
    {
        var operations = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NativeSetupOperations")!;
        var parse = operations.GetMethod("ReadSavedSettings", BindingFlags.Static | BindingFlags.NonPublic)!;
        object Read(string value) => parse.Invoke(null, new object[] { value, "openclaw" })!;
        string Saved(string provider, string endpoint, string model) => System.Text.Json.JsonSerializer.Serialize(new
        {
            schemaVersion = 1, kind = "native-saved-settings", agent = "openclaw", state = "saved",
            settings = new { inference = provider, endpoint, model, credentialStored = provider is "nvidia" or "openrouter", options = new
            {
                search = new { provider = "tavily", credentialStored = true },
                messaging = new Dictionary<string, object> {
                    ["telegram"] = new { credentialStored = true, allowedUsers = new[] { "123456" } },
                    ["slack"] = new { credentialStored = true, appCredentialStored = true, allowedUsers = new[] { "U123456" } },
                },
            } },
        });
        var services = (UserControl)window.FindName("ServiceOptions");
        foreach (var (provider, endpoint) in new[] {
            ("nvidia", "https://integrate.api.nvidia.com/v1"), ("openrouter", "https://openrouter.ai/api/v1"),
            ("compatible", "https://example.invalid/v1"), ("local", "http://127.0.0.1:12345/v1"),
        })
        {
            ((PasswordBox)window.FindName("CredentialBox")).Password = "fixture-only-inference-key";
            foreach (var name in new[] { "SearchKey", "TelegramKey", "SlackBotKey", "SlackAppKey" })
                ((PasswordBox)services.FindName(name)).Password = "fixture-only-service-key";
            var model = "saved-" + provider + "-model";
            Invoke(window, "ApplySavedSettings", Read(Saved(provider, endpoint, model)));
            if (((ComboBoxItem)((ComboBox)window.FindName("ProviderChoice")).SelectedItem).Tag as string != provider
                || ((TextBox)window.FindName("EndpointBox")).Text != endpoint || ((TextBox)window.FindName("ModelBox")).Text != model
                || ((PasswordBox)window.FindName("CredentialBox")).SecurePassword.Length != 0)
                throw new InvalidOperationException("Saved inference choices were not restored without their key.");
            if (((CheckBox)services.FindName("SearchEnabled")).IsChecked != true
                || ((ComboBoxItem)((ComboBox)services.FindName("SearchProvider")).SelectedItem).Tag as string != "tavily"
                || ((TextBox)services.FindName("TelegramUsers")).Text != "123456"
                || ((TextBox)services.FindName("SlackUsers")).Text != "U123456")
                throw new InvalidOperationException("Saved integration choices were not restored.");
            foreach (var name in new[] { "SearchKey", "TelegramKey", "SlackBotKey", "SlackAppKey" })
                if (((PasswordBox)services.FindName(name)).SecurePassword.Length != 0)
                    throw new InvalidOperationException("Saved choices restored an integration key.");
            try
            {
                services.GetType().GetMethod("CopyCredentials", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(services, null);
                throw new InvalidOperationException("Restored integrations bypassed required key re-entry.");
            }
            catch (TargetInvocationException error) when (error.InnerException is InvalidOperationException) { }
        }
        var valid = Saved("local", "http://127.0.0.1:12345/v1", "selected-model");
        foreach (var invalid in new[] { "null", "{", new string('x', 16385),
            valid.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1"),
            valid.Replace("\"agent\":\"openclaw\"", "\"agent\":\"hermes\""),
            valid.Replace("selected-model", new string('x', 257)),
            valid.Replace("http://127.0.0.1:12345/v1", "https://user:private@example.invalid/v1"),
            valid.Replace("\"state\":\"saved\"", "\"state\":\"unconfigured\""),
            valid.Replace("\"options\":{", "\"secret\":\"must-not-return\",\"options\":{"),
        })
        {
            try { Read(invalid); throw new InvalidOperationException("Invalid saved settings were accepted."); }
            catch (TargetInvocationException error) when (error.InnerException is InvalidOperationException) { }
        }
        var modelType = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NativeExpressSetup")!;
        var localModel = modelType.GetProperty("Id", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null);
        var localName = modelType.GetProperty("Model", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null);
        var managed = System.Text.Json.JsonSerializer.Serialize(new { schemaVersion = 1, kind = "native-saved-settings", agent = "openclaw", state = "saved",
            settings = new { inference = "local", model = localName, localModel, credentialStored = false, options = new { } } });
        Invoke(window, "ApplySavedSettings", Read(managed));
        var choice = (ComboBoxItem)((ComboBox)window.FindName("ProviderChoice")).SelectedItem;
        if (choice.IsEnabled || choice.Tag as string != "n1x")
            throw new InvalidOperationException("Unavailable saved models silently became an available provider.");
        Invoke(window, "AddModelChoice", new ComboBoxItem { Tag = "n1x", Content = "Fixture available model" });
        if (!choice.IsEnabled || ((ComboBox)window.FindName("ProviderChoice")).Items.OfType<ComboBoxItem>().Count(item => item.Tag as string == "n1x") != 1)
            throw new InvalidOperationException("Available model refresh did not restore the saved selection exactly once.");
        ((ComboBox)window.FindName("ProviderChoice")).SelectedIndex = 0;
        ((ComboBox)window.FindName("ProviderChoice")).Items.Remove(choice);
        Invoke(window, "ApplySavedSettings", Read("{\"schemaVersion\":1,\"kind\":\"native-saved-settings\",\"agent\":\"openclaw\",\"state\":\"needs-resave\",\"settings\":null}"));
        if (((Border)window.FindName("ConfigurationErrorPanel")).Visibility != Visibility.Visible)
            throw new InvalidOperationException("Unfinished saves were silently treated as saved settings.");
    }

    private static void AssertSavedLoading(MainWindow window)
    {
        const string empty = "{\"schemaVersion\":1,\"kind\":\"native-saved-settings\",\"agent\":\"openclaw\",\"state\":\"unconfigured\",\"settings\":null}";
        const string saved = "{\"schemaVersion\":1,\"kind\":\"native-saved-settings\",\"agent\":\"openclaw\",\"state\":\"saved\",\"settings\":{\"inference\":\"local\",\"endpoint\":\"http://127.0.0.1:12345/v1\",\"model\":\"loaded-model\",\"credentialStored\":false,\"options\":{\"messaging\":{\"telegram\":{\"credentialStored\":true,\"allowedUsers\":[\"123456\"]}}}}}";
        var availability = typeof(MainWindow).GetField("runtimeAvailability", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var loader = typeof(MainWindow).GetField("readSavedSettings", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var original = availability.GetValue(window);
        var originalLoader = loader.GetValue(window);
        var installed = typeof(MainWindow).GetField("packageInstalled", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var originalInstalled = installed.GetValue(window);
        installed.SetValue(window, true);
        var record = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, classification = "native-runtime-package-availability",
            runtimeId = new string('a', 64), manifestSha256 = new string('b', 64), sourceRevision = new string('c', 40),
            agents = new[] { new {agent = "openclaw", status = "qualified"}, new {agent = "hermes", status = "qualified"} } });
        availability.SetValue(window, availability.FieldType.GetMethod("Parse", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, new object[] {record}));
        Invoke(window, "ApplyRuntimeAvailability");
        var panel = (Grid)window.FindName("ConfigurationPanel");
        var install = (Button)window.FindName("InstallButton");
        ((CheckBox)window.FindName("LicenseCheck")).IsChecked = true;
        try
        {
            var response = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            loader.SetValue(window, (Func<string, Task<string>>)(_ => response.Task));
            var loading = (Task)Invoke(window, "LoadSavedSettingsAsync")!;
            if (panel.IsEnabled || install.IsEnabled) throw new InvalidOperationException("Saving remained enabled before saved choices were confirmed.");
            response.SetResult(saved);
            Finish(loading);
            if (!panel.IsEnabled || !install.IsEnabled || ((TextBox)window.FindName("ModelBox")).Text != "loaded-model")
                throw new InvalidOperationException("Confirmed saved choices did not restore the editor.");
            var reloads = 0;
            loader.SetValue(window, (Func<string, Task<string>>)(_ => { reloads++; return Task.FromResult(saved); }));
            Invoke(window, "AgentSelected", new RadioButton {Tag = "hermes"}, new RoutedEventArgs());
            Invoke(window, "ConfigureClicked", window, new RoutedEventArgs());
            Invoke(window, "AgentSelected", new RadioButton {Tag = "openclaw"}, new RoutedEventArgs());
            Invoke(window, "ConfigureClicked", window, new RoutedEventArgs());
            var services = (UserControl)window.FindName("ServiceOptions");
            if (reloads != 1 || ((CheckBox)services.FindName("TelegramEnabled")).IsChecked != true
                || ((TextBox)services.FindName("TelegramUsers")).Text != "123456")
                throw new InvalidOperationException("Returning to OpenClaw reused a stale loaded flag after clearing integration choices.");
            loader.SetValue(window, (Func<string, Task<string>>)(_ => Task.FromException<string>(new IOException("fixture unavailable"))));
            Finish((Task)Invoke(window, "LoadSavedSettingsAsync")!);
            if (install.IsEnabled || ((TextBox)window.FindName("ModelBox")).Text != "loaded-model")
                throw new InvalidOperationException("Failed lookup authorized overwriting saved choices with defaults.");
            response = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            loader.SetValue(window, (Func<string, Task<string>>)(_ => response.Task));
            loading = (Task)Invoke(window, "LoadSavedSettingsAsync")!;
            Invoke(window, "AgentSelected", new RadioButton {Tag = "hermes"}, new RoutedEventArgs());
            ((TextBox)window.FindName("ModelBox")).Text = "other-agent-draft";
            response.SetResult(saved);
            Finish(loading);
            if (window.SelectedAgent != "hermes" || ((TextBox)window.FindName("ModelBox")).Text != "other-agent-draft")
                throw new InvalidOperationException("A late OpenClaw lookup overwrote another agent's choices.");
            Invoke(window, "AgentSelected", new RadioButton {Tag = "openclaw"}, new RoutedEventArgs());
            loader.SetValue(window, (Func<string, Task<string>>)(_ => Task.FromResult(empty)));
            Finish((Task)Invoke(window, "LoadSavedSettingsAsync")!);
        }
        finally
        {
            availability.SetValue(window, original);
            loader.SetValue(window, originalLoader);
            installed.SetValue(window, originalInstalled);
            Invoke(window, "ApplyRuntimeAvailability");
            ((CheckBox)window.FindName("LicenseCheck")).IsChecked = false;
        }
        void Finish(Task operation)
        {
            var watch = System.Diagnostics.Stopwatch.StartNew();
            while (!operation.IsCompleted && watch.Elapsed < TimeSpan.FromSeconds(5))
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ApplicationIdle);
            if (!operation.IsCompleted) throw new TimeoutException("The saved-choice fixture did not finish.");
            operation.GetAwaiter().GetResult();
        }
    }

    private static void AssertPresentationLayout(MainWindow window)
    {
        var output = Environment.GetEnvironmentVariable("NEMOCLAW_SETUP_PRESENTATION_EVIDENCE");
        if (!string.IsNullOrWhiteSpace(output))
        {
            output = Path.GetFullPath(output);
            if (Directory.Exists(output) || File.Exists(output))
                throw new InvalidOperationException("Setup presentation evidence must use a fresh directory.");
            Directory.CreateDirectory(output);
        }
        var root = (FrameworkElement)window.Content;
        foreach (var size in new[] { new Size(1080, 740), new Size(860, 600), new Size(640, 480) })
        {
            window.MinWidth = 640;
            window.MinHeight = 480;
            window.Width = size.Width;
            window.Height = size.Height;
            window.ShowConfiguredSuccess();
            Capture("saved-settings", (Button)window.FindName("CloseButton"));
            window.ShowFailure("The runtime could not start. Your saved provider, endpoint and model choices have not changed. Review the setup log, then retry after the runtime is repaired.", "");
            Capture("startup-failure", (Button)window.FindName("FailureCloseButton"));
            if (Invoke(window, "TryBeginConfiguration") is not true)
                throw new InvalidOperationException("The presentation fixture rejected its save observation.");
            Invoke(window, "ShowConfigurationUnconfirmed", Environment.ProcessId);
            Capture("save-recovery", (Button)window.FindName("ConfigurationRecoveryButton"));
            Invoke(window, "CompleteConfigurationObservation");

            void Capture(string scene, Button requiredAction)
            {
                window.UpdateLayout();
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ApplicationIdle);
                if (!requiredAction.IsVisible)
                    throw new InvalidOperationException($"Setup {scene} has no visible completion/recovery action.");
                var actions = ((Panel)requiredAction.Parent).Children.OfType<Button>().Where(value => value.IsVisible).ToArray();
                var actionBounds = actions.Select(value => value.TransformToAncestor(root).TransformBounds(new Rect(value.RenderSize))).ToArray();
                foreach (var bounds in actionBounds)
                {
                    if (!new Rect(root.RenderSize).Contains(bounds))
                        throw new InvalidOperationException($"Setup {scene} hides its completion/recovery action at {size.Width}x{size.Height}.");
                }
                for (var first = 0; first < actionBounds.Length; first++)
                    for (var second = first + 1; second < actionBounds.Length; second++)
                    {
                        var overlap = Rect.Intersect(actionBounds[first], actionBounds[second]);
                        if (!overlap.IsEmpty && overlap.Width > 0 && overlap.Height > 0)
                            throw new InvalidOperationException($"Setup {scene} overlaps its actions at {size.Width}x{size.Height}.");
                    }
                // Bitmap capture is optional; action visibility and geometry always run.
                if (string.IsNullOrWhiteSpace(output)) return;
                var bitmap = new RenderTargetBitmap((int)root.ActualWidth, (int)root.ActualHeight, 96, 96, PixelFormats.Pbgra32);
                var visual = new DrawingVisual();
                using (var drawing = visual.RenderOpen())
                    drawing.DrawRectangle(new VisualBrush(root), null, new Rect(root.RenderSize));
                bitmap.Render(visual);
                var pixels = new byte[bitmap.PixelWidth * bitmap.PixelHeight * 4];
                bitmap.CopyPixels(pixels, bitmap.PixelWidth * 4, 0);
                if (!HasRenderedContent(pixels, bitmap.PixelWidth, bitmap.PixelHeight))
                {
                    var control = new DrawingVisual();
                    using (var drawing = control.RenderOpen()) drawing.DrawRectangle(Brushes.White, null, new Rect(0, 0, 64, 64));
                    var controlBitmap = new RenderTargetBitmap(64, 64, 96, 96, PixelFormats.Pbgra32);
                    controlBitmap.Render(control);
                    var controlPixels = new byte[64 * 64 * 4];
                    controlBitmap.CopyPixels(controlPixels, 64 * 4, 0);
                    var controlOpaque = controlPixels.Where((value, index) => index % 4 == 3 && value != 0).Count();
                    throw new InvalidOperationException($"Setup presentation capture was blank; independent opaque drawing pixels={controlOpaque}.");
                }
                var encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using (var image = new FileStream(Path.Combine(output, $"{scene}-{size.Width}x{size.Height}.png"), FileMode.CreateNew))
                    encoder.Save(image);
                File.WriteAllText(Path.Combine(output, $"{scene}-{size.Width}x{size.Height}.json"),
                    System.Text.Json.JsonSerializer.Serialize(new
                    {
                        schemaVersion = 1, classification = "owned-wpf-component-presentation-frame", captureMethod = "wpf-render-target",
                        scene, requestedWidth = size.Width, requestedHeight = size.Height,
                        pixelWidth = bitmap.PixelWidth, pixelHeight = bitmap.PixelHeight,
                        componentFixture = true, installedAcceptance = false,
                    }));
            }
        }
        window.Width = 1080;
        window.Height = 740;
        window.ShowReady(false);
    }

    internal static void Run()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            MainWindow? window = null;
            var closed = false;
            var cancelRequests = 0;
            try
            {
                SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher));
                AssertPixelGuard();
                if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("NEMOCLAW_SETUP_PRESENTATION_EVIDENCE")))
                    RenderOptions.ProcessRenderMode = System.Windows.Interop.RenderMode.SoftwareOnly;
                window = new MainWindow();
                AssertCompletionPresentation(window);
                AssertProviderChoices(window);
                AssertSavedOutputBounds();
                AssertSavedChoices(window);
                window.Closed += (_, _) => closed = true;
                window.ModelSetupCancelRequested += (_, _) => cancelRequests++;
                window.Show();
                AssertSavedLoading(window);
                AssertPresentationLayout(window);
                if (Invoke(window, "TryBeginConfiguration") is not true)
                    throw new InvalidOperationException("Setup rejected the fixture save.");
                Invoke(window, "ShowConfigurationUnconfirmed", Environment.ProcessId);
                window.Close();
                if (closed || !window.IsVisible || !window.ShowInTaskbar || window.WindowState != WindowState.Minimized)
                    throw new InvalidOperationException("Closing unconfirmed Setup removed its taskbar recovery window.");
                window.WindowState = WindowState.Normal;
                var recovery = window.FindName("ConfigurationRecoveryButton") as Button;
                if (!window.IsVisible || recovery is null || !recovery.IsVisible || !recovery.IsEnabled)
                    throw new InvalidOperationException("Restoring Setup did not restore its save-status control.");
                if (Invoke(window, "TryBeginConfiguration") is not false || cancelRequests != 1)
                    throw new InvalidOperationException("Closing recovery admitted a second save or lost model cancellation.");
                Invoke(window, "CompleteConfigurationObservation");
                if (!closed)
                    throw new InvalidOperationException("Setup ignored the close request after its owner completed.");
            }
            catch (Exception error) { failure = error; }
            finally
            {
                try
                {
                    if (window is not null && !closed)
                    {
                        Invoke(window, "CompleteConfigurationObservation");
                        if (!closed)
                        {
                            window.ShowConfiguredSuccess();
                            window.Close();
                        }
                    }
                }
                catch (Exception error) { failure ??= error; }
                finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); }
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!thread.Join(TimeSpan.FromSeconds(30)))
            throw new TimeoutException("The Setup recovery window control did not finish.");
        if (failure is not null) throw new InvalidOperationException("Setup recovery window control failed.", failure);
        Console.WriteLine("Windows Setup restores saved choices without keys, bounds metadata, preserves provider drafts and agent boundaries; recovery remains accessible until its owner completes.");
    }
}
#endif
