// EVE Desktop Orb — a small abstract energy orb that lives ON the desktop
// (below normal app windows), shows EVE's live state through its glow, and
// opens/activates EVE QuickBar when clicked.
//
// Design (owner-directed): a soft radial teal glow with a warm-white core —
// deliberately NOT an eye. No wireframe rings, no pupil, no dark surround:
// nothing symmetric-dark-around-bright. All state is expressed through the
// glow's intensity and hue only (breathing idle, teal↔purple hue pulse
// processing, emanating glow waves speaking, dim gray offline).
//
// Single file, no shared target with QuickBar.swift — the WebSocket
// connection class and color constants are intentionally duplicated here.

import Cocoa

// MARK: - EVE palette (ground-truth values from face/style.css)

enum EveColor {
    static func teal(_ a: CGFloat) -> NSColor { NSColor(calibratedRed: 0.176, green: 0.831, blue: 0.659, alpha: a) }
    static func purple(_ a: CGFloat) -> NSColor { NSColor(calibratedRed: 0.486, green: 0.420, blue: 0.941, alpha: a) }
    // Warm white with a teal bias — the "marble" centre of the glow.
    static func warmWhite(_ a: CGFloat) -> NSColor { NSColor(calibratedRed: 0.93, green: 1.0, blue: 0.96, alpha: a) }
}

// MARK: - The energy orb: glow only, no eye.

final class OrbView: NSView {
    enum OrbState { case idle, processing, speaking, offline }
    private(set) var state: OrbState = .offline

    private let halo = CAGradientLayer()   // ambient glow
    private let halo2 = CAGradientLayer()  // second glow wave (speaking)
    private let body = CAGradientLayer()   // the bright marble
    private let tint = CAGradientLayer()   // purple overlay, crossfaded when processing

    var onClick: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        let d = frameRect.width

        for g in [halo, halo2] {
            g.type = .radial
            g.startPoint = CGPoint(x: 0.5, y: 0.5)
            g.endPoint = CGPoint(x: 1.0, y: 0.5)
            g.frame = bounds
            g.cornerRadius = d / 2
            g.masksToBounds = true
            layer?.addSublayer(g)
        }
        halo2.opacity = 0

        for g in [body, tint] {
            g.type = .radial
            g.startPoint = CGPoint(x: 0.5, y: 0.5)
            g.endPoint = CGPoint(x: 1.0, y: 0.5)
            let side = d * 0.60
            g.frame = CGRect(x: (d - side) / 2, y: (d - side) / 2, width: side, height: side)
            g.cornerRadius = side / 2
            g.masksToBounds = true
            layer?.addSublayer(g)
        }
        tint.opacity = 0

        setState(.offline)
    }

    required init?(coder: NSCoder) { fatalError("no coder") }

    func setState(_ s: OrbState) {
        state = s
        [halo, halo2, body, tint].forEach { $0.removeAllAnimations() }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        switch s {
        case .idle:
            halo.colors = [EveColor.teal(0.34).cgColor, EveColor.teal(0.12).cgColor, EveColor.teal(0).cgColor]
            halo.locations = [0, 0.55, 1]
            halo.opacity = 1
            halo2.opacity = 0
            body.colors = [EveColor.warmWhite(1).cgColor, EveColor.teal(0.85).cgColor, EveColor.teal(0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.opacity = 0
        case .processing:
            halo.colors = [EveColor.teal(0.36).cgColor, EveColor.teal(0.13).cgColor, EveColor.teal(0).cgColor]
            halo.locations = [0, 0.55, 1]
            halo.opacity = 1
            halo2.opacity = 0
            body.colors = [EveColor.warmWhite(1).cgColor, EveColor.teal(0.85).cgColor, EveColor.teal(0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.colors = [EveColor.warmWhite(0.9).cgColor, EveColor.purple(0.85).cgColor, EveColor.purple(0).cgColor]
            tint.locations = [0, 0.45, 1]
        case .speaking:
            halo.colors = [EveColor.teal(0.42).cgColor, EveColor.teal(0.16).cgColor, EveColor.teal(0).cgColor]
            halo.locations = [0, 0.55, 1]
            halo.opacity = 0.9
            halo2.colors = [EveColor.teal(0.32).cgColor, EveColor.teal(0.11).cgColor, EveColor.teal(0).cgColor]
            halo2.locations = [0, 0.55, 1]
            halo2.opacity = 0.9
            body.colors = [EveColor.warmWhite(1).cgColor, EveColor.teal(0.85).cgColor, EveColor.teal(0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.opacity = 0
        case .offline:
            halo.colors = [NSColor(calibratedWhite: 0.55, alpha: 0.14).cgColor, NSColor(calibratedWhite: 0.55, alpha: 0).cgColor]
            halo.locations = [0, 1]
            halo.opacity = 1
            halo2.opacity = 0
            body.colors = [NSColor(calibratedWhite: 0.7, alpha: 0.5).cgColor, NSColor(calibratedWhite: 0.55, alpha: 0.22).cgColor, NSColor(calibratedWhite: 0.5, alpha: 0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.opacity = 0
        }
        CATransaction.commit()

        // Motion — glow intensity/scale only, never shape.
        switch s {
        case .idle:
            breathe(halo, duration: 3.8, scale: 1.06)
            breathe(body, duration: 3.8, scale: 1.03)
        case .processing:
            breathe(halo, duration: 1.4, scale: 1.10)
            let x = CABasicAnimation(keyPath: "opacity")
            x.fromValue = 0.0
            x.toValue = 1.0
            x.duration = 0.9
            x.autoreverses = true
            x.repeatCount = .infinity
            x.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            tint.add(x, forKey: "huePulse")
        case .speaking:
            glowWave(halo, delay: 0.0)
            glowWave(halo2, delay: 0.65)
            throb(body, duration: 0.65)
        case .offline:
            break
        }
    }

    private func breathe(_ l: CALayer, duration: CFTimeInterval, scale: CGFloat) {
        let anim = CABasicAnimation(keyPath: "transform.scale")
        anim.fromValue = 1.0
        anim.toValue = scale
        anim.duration = duration
        anim.autoreverses = true
        anim.repeatCount = .infinity
        anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        l.add(anim, forKey: "breathe")
    }

    private func throb(_ l: CALayer, duration: CFTimeInterval) {
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = 1.0
        anim.toValue = 0.75
        anim.duration = duration
        anim.autoreverses = true
        anim.repeatCount = .infinity
        anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        l.add(anim, forKey: "throb")
    }

    // An emanating wave of light: the glow swells outward and fades. Two of
    // these, out of phase, read as ripples of light — no shapes involved.
    private func glowWave(_ l: CALayer, delay: CFTimeInterval) {
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 1.0
        scale.toValue = 1.28
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9
        fade.toValue = 0.10
        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = 1.3
        group.repeatCount = .infinity
        group.beginTime = CACurrentMediaTime() + delay
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        l.add(group, forKey: "wave")
    }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    override func rightMouseDown(with event: NSEvent) {
        menu?.popUp(positioning: nil, at: convert(event.locationInWindow, from: nil), in: self)
    }
}

// MARK: - Connection to EVE's face server (duplicated from QuickBar.swift by design)

final class EveConnection: NSObject, URLSessionWebSocketDelegate {
    private var ws: URLSessionWebSocketTask?
    private var url: URL?
    private var backoff: TimeInterval = 1.5
    private let maxBackoff: TimeInterval = 10.0
    var onEvent: (([String: Any]) -> Void)?
    private(set) var connected = false

    func connect(to url: URL) {
        self.url = url
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        task.delegate = self
        ws = task
        task.resume()
        receive()
    }

    private func receive() {
        ws?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure:
                DispatchQueue.main.async {
                    self.connected = false
                    self.onEvent?(["type": "_disconnected"])
                }
                self.scheduleReconnect()
            case .success(let msg):
                if case .string(let text) = msg,
                   let data = text.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async { self.onEvent?(obj) }
                }
                self.receive()
            }
        }
    }

    private func scheduleReconnect() {
        let delay = backoff
        backoff = min(backoff * 1.5, maxBackoff)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, let url = self.url else { return }
            self.connect(to: url)
        }
    }

    func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        ws?.send(.string(text)) { _ in }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        backoff = 1.5
        connected = true
        DispatchQueue.main.async { self.onEvent?(["type": "_connected"]) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard connected || error != nil else { return }
        connected = false
        DispatchQueue.main.async { self.onEvent?(["type": "_disconnected"]) }
        scheduleReconnect()
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var orb: OrbView!
    let conn = EveConnection()

    private let quickBarBundleID = "com.umberto.eve.quickbar"
    private let positionDefaultsKey = "EveOrbWindowOrigin"
    private let windowSize: CGFloat = 132

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let rect = NSRect(x: 0, y: 0, width: windowSize, height: windowSize)
        window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = false
        window.collectionBehavior = [.canJoinAllSpaces, .stationary]
        window.isMovableByWindowBackground = true
        // Just above the desktop icons, below normal windows — a desktop pet.
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)

        if let saved = UserDefaults.standard.string(forKey: positionDefaultsKey) {
            window.setFrameOrigin(NSPointFromString(saved))
        } else if let screen = NSScreen.main {
            let f = screen.visibleFrame
            let margin: CGFloat = 40
            window.setFrameOrigin(NSPoint(x: f.maxX - windowSize - margin, y: f.minY + margin))
        }

        orb = OrbView(frame: NSRect(x: 0, y: 0, width: windowSize, height: windowSize))
        orb.onClick = { [weak self] in self?.openQuickBar() }
        orb.menu = makeContextMenu()
        window.contentView = orb

        window.orderFrontRegardless()

        NotificationCenter.default.addObserver(
            self, selector: #selector(windowDidMove),
            name: NSWindow.didMoveNotification, object: window)

        conn.onEvent = { [weak self] ev in self?.handle(ev) }
        conn.connect(to: URL(string: "ws://127.0.0.1:3939/")!)
    }

    @objc private func windowDidMove(_ note: Notification) {
        UserDefaults.standard.set(NSStringFromPoint(window.frame.origin), forKey: positionDefaultsKey)
    }

    private func makeContextMenu() -> NSMenu {
        let menu = NSMenu()
        let quit = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        return menu
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    private func openQuickBar() {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: quickBarBundleID)
        if running.first != nil {
            DistributedNotificationCenter.default().postNotificationName(
                NSNotification.Name("com.umberto.eve.quickbar.show"), object: nil, userInfo: nil, deliverImmediately: true)
        } else {
            let path = NSHomeDirectory() + "/TRILLION/desktop/dist/EVE-QuickBar.app"
            let url = URL(fileURLWithPath: path)
            let config = NSWorkspace.OpenConfiguration()
            NSWorkspace.shared.openApplication(at: url, configuration: config, completionHandler: nil)
        }
    }

    private func applyStateString(_ s: String) {
        switch s {
        case "processing": orb.setState(.processing)
        case "speaking": orb.setState(.speaking)
        case "listening", "idle": orb.setState(.idle)
        default: break
        }
    }

    private func handle(_ ev: [String: Any]) {
        guard let type = ev["type"] as? String else { return }
        switch type {
        case "_connected":
            break // real state comes from the "snapshot" message that follows
        case "_disconnected":
            orb.setState(.offline)
        case "snapshot":
            if let snap = ev["snapshot"] as? [String: Any], let s = snap["state"] as? String {
                applyStateString(s)
            }
        case "state":
            if let s = ev["state"] as? String { applyStateString(s) }
        default:
            break
        }
    }
}

// MARK: - main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
