// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#if NATIVE_WPF_CONTROLS
extern alias NativeBootstrapper;

using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using MainWindow = NativeBootstrapper::Nvidia.NemoClaw.Bootstrapper.MainWindow;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class WindowRecoveryControls
{
    private static object? Invoke(MainWindow window, string method, params object[] arguments) =>
        (typeof(MainWindow).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException($"Missing Setup operation: {method}."))
        .Invoke(window, arguments);

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
                window = new MainWindow();
                window.Closed += (_, _) => closed = true;
                window.ModelSetupCancelRequested += (_, _) => cancelRequests++;
                window.Show();
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
        Console.WriteLine("Windows Setup recovery remains accessible from the taskbar until its owner completes.");
    }
}
#endif
