// EVE QuickBar — minimal Jarvis-style glass strip, top-center of the main
// screen. Non-activating NSPanel so it never steals focus from whatever app
// the user was in (Glaido dictation types into our chat field regardless of
// which app is frontmost, as long as the field has keyboard focus).
//
// Design (owner-directed): dark vibrancy glass, ONE row — a small abstract
// energy orb (soft radial teal glow with a warm-white core; deliberately NOT
// an eye: no ring, no sclera contrast, nothing symmetric-dark-around-bright)
// plus the input field with a subtle teal underline. Reply text sits above in
// one or two lines. Nothing else. State shows through the orb's GLOW only —
// breathing idle, teal↔purple hue pulse processing, emanating glow waves
// speaking — never through shapes that could read as a facial expression.
// No blue anywhere: focusRingType .none, no bezel.

import Cocoa
import AVFoundation

// MARK: - EVE palette (ground-truth values from face/style.css)

enum EveColor {
    static func teal(_ a: CGFloat) -> NSColor { NSColor(calibratedRed: 0.176, green: 0.831, blue: 0.659, alpha: a) }
    static func purple(_ a: CGFloat) -> NSColor { NSColor(calibratedRed: 0.486, green: 0.420, blue: 0.941, alpha: a) }
    static func amber(_ a: CGFloat) -> NSColor { NSColor(calibratedRed: 0.941, green: 0.761, blue: 0.416, alpha: a) }
    static func errorRed(_ a: CGFloat) -> NSColor { NSColor(calibratedRed: 0.94, green: 0.48, blue: 0.48, alpha: a) }
    // Warm white with a teal bias — the "marble" centre of the glow.
    static func warmWhite(_ a: CGFloat) -> NSColor { NSColor(calibratedRed: 0.93, green: 1.0, blue: 0.96, alpha: a) }
    static let glassTint = NSColor(calibratedRed: 12.0 / 255.0, green: 14.0 / 255.0, blue: 20.0 / 255.0, alpha: 0.45)
}

// MARK: - The energy orb: glow only, no eye.

final class OrbView: NSView {
    enum OrbState { case idle, processing, speaking, error, offline }
    private(set) var state: OrbState = .offline

    // Radial-gradient layers: a wide soft halo and a bright warm-white core
    // fading into teal. All state changes are opacity/scale of light — no
    // rings, no dark surround, nothing that reads as a pupil.
    private let halo = CAGradientLayer()   // ambient glow
    private let halo2 = CAGradientLayer()  // second glow wave (speaking)
    private let body = CAGradientLayer()   // the bright marble
    private let tint = CAGradientLayer()   // purple overlay, crossfaded when processing

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
            let side = d * 0.66
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
        // Clear every running animation before applying the new state so no
        // stale pulse keeps glowing underneath.
        [halo, halo2, body, tint].forEach { $0.removeAllAnimations() }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        switch s {
        case .idle:
            halo.colors = [EveColor.teal(0.30).cgColor, EveColor.teal(0.10).cgColor, EveColor.teal(0).cgColor]
            halo.locations = [0, 0.55, 1]
            halo.opacity = 1
            body.colors = [EveColor.warmWhite(1).cgColor, EveColor.teal(0.85).cgColor, EveColor.teal(0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.opacity = 0
            halo2.opacity = 0
        case .processing:
            // Hue pulse: the purple overlay crossfades over the teal glow.
            halo.colors = [EveColor.teal(0.32).cgColor, EveColor.teal(0.12).cgColor, EveColor.teal(0).cgColor]
            halo.locations = [0, 0.55, 1]
            halo.opacity = 1
            body.colors = [EveColor.warmWhite(1).cgColor, EveColor.teal(0.85).cgColor, EveColor.teal(0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.colors = [EveColor.warmWhite(0.9).cgColor, EveColor.purple(0.85).cgColor, EveColor.purple(0).cgColor]
            tint.locations = [0, 0.45, 1]
            halo2.opacity = 0
        case .speaking:
            halo.colors = [EveColor.teal(0.38).cgColor, EveColor.teal(0.14).cgColor, EveColor.teal(0).cgColor]
            halo.locations = [0, 0.55, 1]
            halo2.colors = [EveColor.teal(0.30).cgColor, EveColor.teal(0.10).cgColor, EveColor.teal(0).cgColor]
            halo2.locations = [0, 0.55, 1]
            halo.opacity = 0.9
            halo2.opacity = 0.9
            body.colors = [EveColor.warmWhite(1).cgColor, EveColor.teal(0.85).cgColor, EveColor.teal(0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.opacity = 0
        case .error:
            halo.colors = [EveColor.errorRed(0.28).cgColor, EveColor.errorRed(0).cgColor]
            halo.locations = [0, 1]
            halo.opacity = 1
            body.colors = [EveColor.warmWhite(0.95).cgColor, EveColor.errorRed(0.85).cgColor, EveColor.errorRed(0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.opacity = 0
            halo2.opacity = 0
        case .offline:
            halo.colors = [NSColor(calibratedWhite: 0.55, alpha: 0.14).cgColor, NSColor(calibratedWhite: 0.55, alpha: 0).cgColor]
            halo.locations = [0, 1]
            halo.opacity = 1
            body.colors = [NSColor(calibratedWhite: 0.7, alpha: 0.55).cgColor, NSColor(calibratedWhite: 0.55, alpha: 0.25).cgColor, NSColor(calibratedWhite: 0.5, alpha: 0).cgColor]
            body.locations = [0, 0.45, 1]
            body.opacity = 1
            tint.opacity = 0
            halo2.opacity = 0
        }
        CATransaction.commit()

        // Motion — glow intensity/scale only.
        switch s {
        case .idle:
            breathe(halo, duration: 3.6, scale: 1.05)
            breathe(body, duration: 3.6, scale: 1.03)
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
        case .error, .offline:
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
        scale.toValue = 1.30
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
}

// MARK: - Connection to EVE's face server (URLSessionWebSocketTask)

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

// MARK: - TTS playback: fetch /tts/<segId>, queue segments in seq order

final class AudioQueue: NSObject, AVAudioPlayerDelegate {
    private struct Segment { let segId: String; let seq: Int }
    private var pending: [Segment] = []
    private var currentPlayer: AVAudioPlayer?
    var onStartPlaying: (() -> Void)?
    var onQueueDrained: (() -> Void)?

    func enqueue(segId: String, seq: Int) {
        pending.append(Segment(segId: segId, seq: seq))
        pending.sort { $0.seq < $1.seq }
        if currentPlayer == nil { playNext() }
    }

    func reset() {
        pending.removeAll()
        currentPlayer?.stop()
        currentPlayer = nil
    }

    private func playNext() {
        guard !pending.isEmpty else {
            onQueueDrained?()
            return
        }
        let seg = pending.removeFirst()
        guard let url = URL(string: "http://127.0.0.1:3939/tts/\(seg.segId)") else { playNext(); return }
        onStartPlaying?()
        URLSession.shared.downloadTask(with: url) { [weak self] localUrl, _, err in
            guard let self = self else { return }
            guard let local = localUrl, err == nil else {
                DispatchQueue.main.async { self.playNext() }
                return
            }
            // downloadTask deletes the temp file right after this closure
            // returns — copy it out before hopping to the main thread.
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp3")
            try? FileManager.default.copyItem(at: local, to: dest)
            DispatchQueue.main.async {
                do {
                    let p = try AVAudioPlayer(contentsOf: dest)
                    p.delegate = self
                    self.currentPlayer = p
                    p.play()
                } catch {
                    self.playNext()
                }
            }
        }.resume()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        currentPlayer = nil
        playNext()
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let barWidth: CGFloat = 640
    let barHeight: CGFloat = 110

    var window: NSPanel!
    var orb: OrbView!
    var field: NSTextField!
    var replyLabel: NSTextField!
    var readAllButton: NSButton!
    var confirmCard: NSView?
    var pendingConfirmId: String?
    var sawRealClick = false
    let conn = EveConnection()
    let audio = AudioQueue()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let rect = NSRect(x: 0, y: 0, width: barWidth, height: barHeight)
        window = NSPanel(contentRect: rect,
                         styleMask: [.titled, .fullSizeContentView],
                         backing: .buffered, defer: false)
        // NOT .nonactivatingPanel: Glaido dictates into the FRONTMOST app's
        // focused field. A non-activating panel never becomes the active app,
        // so Glaido had nowhere to write — the bar was deaf to dictation.
        // A normal (activating) panel becomes key on click, so Fn+Ctrl
        // dictates straight into the field. Still floating + all-Spaces.
        window.title = "EVE"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
        window.isFloatingPanel = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .stationary]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true

        // Glass: dark vibrancy behind everything, biased to EVE's tone.
        let vibe = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: barWidth, height: barHeight))
        vibe.material = .underWindowBackground
        vibe.appearance = NSAppearance(named: .darkAqua)
        vibe.blendingMode = .behindWindow
        vibe.state = .active
        vibe.wantsLayer = true
        vibe.layer?.backgroundColor = EveColor.glassTint.cgColor
        vibe.layer?.cornerRadius = 16
        vibe.layer?.masksToBounds = true
        window.contentView = vibe

        if let screen = NSScreen.main {
            let f = screen.frame
            let x = f.midX - barWidth / 2
            window.setFrameOrigin(NSPoint(x: x, y: f.maxY - barHeight - 60))
        }

        // Reply area — one or two lines above the row. Nothing else lives here.
        // Tap/click it and the full text opens in a scrollable window: the bar
        // is a preview, not the place to read a long answer (the owner's "I
        // can't read anything after one line").
        replyLabel = NSTextField(labelWithString: "")
        replyLabel.font = NSFont.systemFont(ofSize: 13, weight: .regular)
        replyLabel.textColor = .white
        replyLabel.maximumNumberOfLines = 2
        replyLabel.cell?.truncatesLastVisibleLine = true
        replyLabel.cell?.wraps = true
        replyLabel.lineBreakMode = .byTruncatingTail
        replyLabel.frame = NSRect(x: 60, y: 46, width: barWidth - 78, height: 42)
        // Click sulla risposta → apre la finestra completa. NSTextField non ha
        // isUserInteractionEnabled (quello è UIKit): il gesto si aggiunge
        // direttamente, e il testo resta non selezionabile per non rubare il
        // click al campo sotto.
        let replyClick = NSClickGestureRecognizer(target: self, action: #selector(openFullReply))
        replyLabel.addGestureRecognizer(replyClick)
        vibe.addSubview(replyLabel)

        // "Read all" affordance: a small chevron button at the reply's right
        // edge — same action as clicking the reply. Visible only when the
        // reply is truncated (updated in handle(chat_delta)/send).
        readAllButton = NSButton(title: "read all", target: self, action: #selector(openFullReply))
        readAllButton.isBordered = false
        readAllButton.font = NSFont.systemFont(ofSize: 10.5, weight: .semibold)
        readAllButton.contentTintColor = EveColor.teal(0.9)
        readAllButton.frame = NSRect(x: barWidth - 96, y: 74, width: 74, height: 16)
        readAllButton.isHidden = true
        vibe.addSubview(readAllButton)

        // The row: small glowing orb + input field.
        orb = OrbView(frame: NSRect(x: 20, y: 15, width: 30, height: 30))
        vibe.addSubview(orb)

        field = NSTextField(frame: NSRect(x: 62, y: 16, width: barWidth - 80, height: 26))
        field.placeholderString = "Ask EVE · Fn+Ctrl to dictate · Enter to send"
        field.font = NSFont.systemFont(ofSize: 13.5, weight: .medium)
        field.textColor = .white
        field.isBezeled = false
        field.isBordered = false
        field.drawsBackground = false
        // NEVER a blue focus ring — focus is the teal underline below.
        field.focusRingType = .none
        field.delegate = self
        vibe.addSubview(field)

        // Focus underline: 2px teal at 60% — the only focus indicator.
        let underline = NSView(frame: NSRect(x: 62, y: 12, width: barWidth - 80, height: 2))
        underline.wantsLayer = true
        underline.layer?.backgroundColor = EveColor.teal(0.6).cgColor
        vibe.addSubview(underline)

        // Close: a visible ✕ that works, plus Esc, plus click-outside. The
        // first version had NO way to close — the owner literally could not
        // dismiss it. The ✕ is 24px, top-right, quiet gray until hover.
        let close = NSButton(title: "✕", target: self, action: #selector(closeBar))
        close.isBordered = false
        close.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        close.contentTintColor = NSColor(calibratedWhite: 0.65, alpha: 1)
        close.frame = NSRect(x: barWidth - 34, y: barHeight - 32, width: 24, height: 24)
        close.wantsLayer = true
        close.layer?.cornerRadius = 6
        vibe.addSubview(close)

        window.orderFrontRegardless()
        window.makeFirstResponder(field)
        // Becoming key ALSO activates the app — exactly what Glaido needs:
        // the active app is now the QuickBar, its focused field is the input.
        NSApp.activate(ignoringOtherApps: true)

        // Esc closes: local monitor on keyDown so it fires while the field
        // has focus (field would otherwise eat Escape).
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] ev in
            if ev.keyCode == 53 { self?.closeBar(); return nil }
            return ev
        }

        // Click-outside closes via DEACTIVATION — no coordinate math at all.
        // When another app is clicked, macOS deactivates us; we hide. But a
        // focus change WITHOUT a click (Glaido's Fn+Ctrl hotkey grabs focus
        // with no mouse event) must NOT close: we track whether a mouse-down
        // actually happened, and only then does deactivation close the bar.
        // Glaido activation = no mouse-down = bar survives, waiting for the
        // dictated text to arrive.
        NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.sawRealClick = true
        }
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] ev in
            // Local = clicks in OUR app: inside the bar (keep) or nowhere
            // else — never a close signal. Just record it.
            self?.sawRealClick = true
            return ev
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            // Close only when a genuine mouse click caused the deactivation.
            // Glaido's hotkey steals focus with NO click — the bar waits.
            if self.sawRealClick { self.closeBar() }
            self.sawRealClick = false
        }
        // When the bar's window becomes key again (e.g. Glaido finishes and
        // focus returns), the field must be first responder so dictated text
        // lands in the input — not into limbo.
        NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main
        ) { [weak self] _ in
            if self?.window?.firstResponder != self?.field?.currentEditor() {
                self?.window?.makeFirstResponder(self?.field)
            }
        }

        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(handleShowRequest),
            name: NSNotification.Name("com.umberto.eve.quickbar.show"), object: nil)

        conn.onEvent = { [weak self] ev in self?.handle(ev) }
        conn.connect(to: URL(string: "ws://127.0.0.1:3939/")!)
    }

    @objc private func handleShowRequest() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(field)
    }

    // Close = hide the window; the app stays resident so reopening (the
    // shortcut, the Orb click, the distributed notification) is instant —
    // no relaunch, no reconnection delay.
    @objc private func closeBar() {
        field.stringValue = ""
        replyLabel.stringValue = ""
        confirmCard?.removeFromSuperview()
        confirmCard = nil
        window.orderOut(nil)
    }

    // Click-outside: close only when the click was NOT ours and the bar is
    // no longer key (i.e. the click moved focus to another app).
    private func closeIfNotKey() {
        if !window.isKeyWindow { closeBar() }
    }

    // The reply is fully readable on EVE's main page — that surface already
    // exists, is beautiful, and scrolls. The old 640x420 floating window was
    // over-engineered and the owner hated it ("enorme window che non si chiude").
    // The bar stays a PREVIEW; "read all" and clicking the reply open the page.
    @objc private func openFullReply() {
        if let url = URL(string: "http://127.0.0.1:3939/") {
            NSWorkspace.shared.open(url)
        }
    }

    // fullReplyWindow/fullReplyShown: removed — see openFullReply(). The
    // bar previews; the main page reads.

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
        case "chat_turn":
            replyLabel.stringValue = ""
            readAllButton.isHidden = true
            orb.setState(.processing)
        case "chat_delta":
            replyLabel.stringValue += ev["text"] as? String ?? ""
            // "read all" appears once the reply clearly overflows the 2-line
            // preview (~140 chars at this size) — a hint, not an exact count.
            if replyLabel.stringValue.count > 130 {
                readAllButton.isHidden = false
            }
        case "speak_segment":
            if let seg = ev["segId"] as? String {
                let seq = ev["seq"] as? Int ?? 0
                audio.enqueue(segId: seg, seq: seq)
            }
        case "chat_done", "turn_done":
            orb.setState(.idle)
        case "turn_error":
            replyLabel.stringValue = "(hiccup) \(ev["message"] as? String ?? "")"
            orb.setState(.error)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.orb.setState(.idle) }
        case "confirm_request":
            showConfirm(id: ev["id"] as? String ?? "", intent: ev["intent"] as? String ?? "")
        case "confirm_resolved":
            confirmCard?.removeFromSuperview()
            confirmCard = nil
            pendingConfirmId = nil
        default:
            break
        }
    }

    // Tier 6 gate: an inline amber card that temporarily occupies the reply
    // area — Allow / Refuse go straight back over the same socket.
    private func showConfirm(id: String, intent: String) {
        confirmCard?.removeFromSuperview()
        pendingConfirmId = id

        let stack = NSStackView()
        stack.frame = NSRect(x: 60, y: 40, width: barWidth - 78, height: 52)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4

        let l = NSTextField(labelWithString: intent)
        l.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        l.textColor = EveColor.amber(1)
        l.maximumNumberOfLines = 1
        l.lineBreakMode = .byTruncatingTail

        let btns = NSStackView()
        btns.orientation = .horizontal
        btns.spacing = 8

        let allow = amberButton(title: "Allow")
        allow.target = self
        allow.action = #selector(confirmYes)
        let deny = amberButton(title: "Refuse")
        deny.target = self
        deny.action = #selector(confirmNo)

        btns.addArrangedSubview(allow)
        btns.addArrangedSubview(deny)
        stack.addArrangedSubview(l)
        stack.addArrangedSubview(btns)

        window.contentView?.addSubview(stack)
        confirmCard = stack
    }

    private func amberButton(title: String) -> NSButton {
        let b = NSButton(title: title, target: nil, action: nil)
        b.bezelStyle = .rounded
        b.controlSize = .small
        let attr = NSAttributedString(string: title, attributes: [
            .foregroundColor: EveColor.amber(1),
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold)
        ])
        b.attributedTitle = attr
        return b
    }

    @objc private func confirmYes() {
        if let id = pendingConfirmId {
            conn.send(["type": "confirm_response", "id": id, "ok": true])
        }
        confirmCard?.removeFromSuperview()
        confirmCard = nil
        pendingConfirmId = nil
    }

    @objc private func confirmNo() {
        if let id = pendingConfirmId {
            conn.send(["type": "confirm_response", "id": id, "ok": false])
        }
        confirmCard?.removeFromSuperview()
        confirmCard = nil
        pendingConfirmId = nil
    }

    // Enter sends. control(_:textShouldEndEditing:) does NOT fire on Enter in
    // a single-line NSTextField — the canonical hook is
    // control(_:textView:doCommandBy:) intercepting insertNewline:.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            send()
            return true
        }
        return false
    }

    private func send() {
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, conn.connected else { return }
        field.stringValue = ""
        replyLabel.stringValue = ""
        readAllButton.isHidden = true
        orb.setState(.processing)
        conn.send(["type": "chat", "text": text])
    }
}

// MARK: - main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
