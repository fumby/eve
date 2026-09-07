// QuickEVE Bar — global shortcut Fn+Left-Option opens the bar.
//
// A tiny menu-bar-free agent: one CGEventTap watches the hid system event
// queue. When it sees flagsChanged with EXACTLY Left-Option (fn is reported
// as a modifier on modern Apple Silicon keyboards), it fires: we open
// http://127.0.0.1:3939/quickbar in Umberto's default browser and swallow
// the event so Glaido's Fn+Left-Ctrl dictation is never disturbed.
//
// Why not a regular .app with a hotkey: EVE's bar is a served web page; the
// natural trigger is the OS-wide one below the app level. This stays a
// background process launched by launchd, runs as Umberto, no extra perms
// beyond Accessibility (already granted to the binary by him).
//
// Build: swiftc -O quickbar-hotkey.swift -o ~/bin/eve-quickbar-hotkey
import Cocoa
import Carbon.HIToolbox

let BAR_URL = "http://127.0.0.1:3939/quickbar"

// The tap: fire when flags = Left Option ONLY (fn is implicit on fn-keyboards,
// reported as NX_DEVICELCTLKEYMASK? no — fn shows as kCGEventFlagMaskSecondaryFn).
// We want Option-Left pressed while fn is held: flags contain option and fn.
let optionDown = CGEventFlags.maskAlternate
let fnMask = CGEventFlags.maskSecondaryFn

var hotkeyArmed = true

func openBar() {
    // The native EVE QuickBar app (desktop/quickbar/) listens for this
    // distributed notification and shows its NSPanel. Opening a browser URL
    // was wrong — Umberto rejected that: the bar is an app, not a web page.
    DistributedNotificationCenter.default().postNotificationName(
        NSNotification.Name("com.umberto.eve.quickbar.show"),
        object: nil, deliverImmediately: true)
}

func eventHandler(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .flagsChanged {
        let flags = event.flags
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        // Left Option keyDown (keycode 58) with fn held (maskSecondaryFn).
        // Glaido owns Fn+Left-CTRL (keycode 59) — untouched.
        if keyCode == 58 && flags.contains(optionDown) {
            if flags.contains(fnMask) {
                openBar()
                return nil // consume it
            }
        }
    }
    // Pass everything else through untouched.
    return Unmanaged.passRetained(event)
}

func makeTap() -> CFMachPort? {
    let eventMask = (1 << CGEventType.flagsChanged.rawValue)
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: CGEventMask(eventMask),
        callback: eventHandler,
        userInfo: nil
    ) else {
        NSLog("EVE-quickbar: event tap creation failed — needs Accessibility permission for this binary.")
        exit(1)
    }
    return tap
}

guard let tap = makeTap() else { exit(1) }
let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
NSLog("EVE-quickbar hotkey agent running (Fn+Left-Option → bar)")
CFRunLoopRun()
