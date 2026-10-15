# @therealityreport/tweakers-native-host

macOS Objective-C++ N-API host for Tweakers overlays, process coordination,
directory swaps, and persistent volume identity.

The addon exports:

- `getCapabilities()` reports AppKit/Metal support.
- `createPanel(options)` creates a child `NSPanel` overlay parented to the
  current Codex `BrowserWindow` native handle.
- `attachView(options)` creates a child overlay containing an `MTKView`.
- `disposeAll()` tears down all native windows created by the host.
- `acquireNativeThreadWriterLease(...)` obtains an identity-checked native
  writer lease for a thread directory.
- `swapDirectories(...)` exchanges verified directories.
- `volumeUuid(path)` reads a persistent macOS volume identifier.

The build also produces the Tweakers Manager Launcher, Tweakers App Launcher,
Tweakers Manager app, and swap helper used by the managed launch and update
flows. These are separate executables, not addon exports.

Direct child `NSView` insertion is not the default path yet. The first 1.0.0
implementation uses a child-window overlay because it is safer against Owl and
Chromium view hierarchy changes.
