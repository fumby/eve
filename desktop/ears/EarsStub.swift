// The launcher — EVE-Ears.app's main executable, compiled ONCE and never
// rebuilt on purpose. macOS privacy (TCC) identifies an ad-hoc signed app by
// the hash of this file's binary; keeping it fixed keeps the Microphone and
// Speech Recognition grants across every rebuild of the real code, which
// lives in libEars.dylib next to the bundle (see the header of Ears.swift).
// If this file ever has to change, the grants must be given again at the
// screen — say so in the commit.
import Foundation

let lib = URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent()
    .appendingPathComponent("EVE-Ears-lib/libEars.dylib").path
guard let handle = dlopen(lib, RTLD_NOW) else {
    FileHandle.standardError.write("ears: cannot load \(lib): \(String(cString: dlerror()))\n".data(using: .utf8)!)
    exit(1)
}
guard let sym = dlsym(handle, "ears_main") else {
    FileHandle.standardError.write("ears: \(lib) has no ears_main\n".data(using: .utf8)!)
    exit(1)
}
typealias Main = @convention(c) () -> Int32
exit(unsafeBitCast(sym, to: Main.self)())
