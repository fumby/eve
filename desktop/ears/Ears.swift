// EVE Ears — the wake word. "Hey Eve", from across the room, opens her ears.
//
// A tiny always-on helper, built like the quick-bar hotkey: one Swift file,
// an ad-hoc-signed .app bundle so macOS can show it a Microphone and a Speech
// Recognition prompt (a bare launchd process gets neither — the desktop
// README learned that with WebKit), launched by launchd as Umberto at login.
//
// What it does, and what it deliberately does not:
//
//  1. It listens with Apple's ON-DEVICE speech recognition, English (US),
//     `requiresOnDeviceRecognition = true`. Nothing leaves the Mac while it
//     waits for the phrase. It refuses to fall back to Apple's servers: an
//     always-on microphone streaming a room to a third party is not a trade
//     this house makes. (Apple caps one recognition request at about a
//     minute, so the request is restarted every 45 s, and on every error.)
//  2. On the phrase it plays a short pop — the room's cue that she is
//     listening — and becomes a FACE CLIENT: it opens the same WebSocket a
//     browser tab does, says what it is (client_info: mac), turns the mic on,
//     streams 16 kHz mono Int16 PCM until he stops talking (a second of
//     quiet after speech; six seconds of nothing = never mind), turns the mic
//     off, and plays the spoken segments the server streams back, in order.
//     Same brain, same tools, same gate, same transcript — only the ears and
//     mouth are in a different process. It connects per turn, not
//     persistently: the server runs the memory extractor when the LAST client
//     leaves, and a permanent socket would have meant it never left.
//  3. It never answers the gate. A tool that needs his yes shows its card on
//     the face (the server broadcasts it); the log says so. The wake-up song
//     is the one standing yes, and starts without a card.
//  4. It DOES hear "Hey Eve" while she is speaking: the recogniser is off
//     only while his own words are being streamed, and comes back the moment
//     the mic closes. The phrase over her voice stops playback, drops what
//     was queued, tells the server to interrupt, and opens the mic again on
//     the same socket — she stops talking, listens, and answers the new
//     thing. (Her own voice reaches the recogniser through the speakers; the
//     matcher needs "hey/hi/ehi/ok/a" before her name, so her saying "Eve"
//     alone does not wake her.)
//
// Shape: a LAUNCHER and a LIBRARY. macOS privacy (TCC) identifies an ad-hoc
// signed app by the hash of its main executable, so every rebuild of a
// one-file app was a brand-new app that had to be allowed again — and an
// instance started while nobody was at the screen waited forever for a
// dialog. So the bundle's executable is EarsStub.swift, a few lines that
// dlopen this file compiled as libEars.dylib (kept OUTSIDE the bundle, in
// desktop/dist/EVE-Ears-lib/, so it is not part of the bundle's sealed
// resources) and call ears_main. The stub is compiled once and reused; its
// hash — the app's identity — never changes, and this file can be rebuilt
// as often as it likes.
//
// Build: bash desktop/ears/build.sh   Install: bash desktop/ears/install.sh
// Debug without a mic: Ears --selftest (permission states, on-device support,
// server reachability — never prompts) · Ears --ws-selftest (the wire, one
// second of silence, expects "couldn't make out" back) · Ears --recognize-file
// hey.aiff (runs the wake matcher on a file; needs Speech permission).
// Debug without SPEAKERS: Ears --inject-file q.aiff [--barge hey.aiff] feeds a
// clip into the very pipeline the microphone feeds (recogniser, rotation,
// gate, streaming, her reply fetched but not played) and, with --barge, feeds
// the second clip over her reply — the whole wake-to-answer path, silently.
// Ears --mic-level 5 prints the room's noise floor for five seconds.
import AVFoundation
import Cocoa
import Foundation
import Speech

let SERVER = "127.0.0.1:3939"

let stamp = ISO8601DateFormatter()
func log(_ s: String) {
    FileHandle.standardError.write("\(stamp.string(from: Date())) ears: \(s)\n".data(using: .utf8)!)
}

// The phrase, as the recogniser actually hears it. Her name is one short
// vowel-heavy syllable and comes back as "Eve", "Evie", "Eva", "Evy", "Ivy",
// "Eevee", "E" or "V" — the first live test at volume 30 gave "Hey Evie" and
// never fired against a list of four. The greeting comes back as "hey", "hi",
// "ehi" (Italian), "hei", "ey", or a bare "a". Anchored to word boundaries on
// both sides, so "hey, even so" and "hey everyone" do not wake her.
// The name is matched by shape as well as by spelling: vowels, a v, vowels —
// "eve", "evie", "eva", "ava", "iv", "eevee" — which "even" and "everyone"
// (a consonant after the v) never fit.
let WAKE = try! NSRegularExpression(
    pattern: "\\b(hey|hi|ehi|hei|ey|ok|okay|a)[,]?\\s+(eve|evie|evy|evi|eva|ava|eevee|eevi|eeve|eev|eave|heave|ivy|[aeiy]{1,3}v[aeiy]{0,3}|e|v)\\b",
    options: [.caseInsensitive]
)
let GREETING = try! NSRegularExpression(pattern: "\\b(hey|hi|ehi|hei|ey)\\b", options: [.caseInsensitive])
func hasGreeting(_ t: String) -> Bool {
    GREETING.firstMatch(in: t, options: [], range: NSRange(t.startIndex..., in: t)) != nil
}
// His own way of saying it fuses: Neapolitan "a' Eve" reaches the recogniser
// as ONE token — "AEVA", "AEVEVA", "AVA" — no greeting, no space (found by the
// wake-learn.mjs log mining on the first night). A vowel-run, a v, a vowel-run,
// standing at the START of what was heard, is him calling her.
// One or two v's: "AEVA" and "AEVEVA" both. The token must open with his
// "a'" or with two vowels — a bare "Eve" at the start of an utterance is her
// own name in her own mouth (she speaks through the same speakers the mic
// hears) and must not cut her off. A consonant after the last vowel run
// ("even", "every", "avenue") breaks the word boundary and never matches.
let FUSED = try! NSRegularExpression(pattern: "^\\W*(?:a[aeiouy]{0,7}|[aeiouy]{2,8})(?:v[aeiouy]{0,4}){1,2}\\b", options: [.caseInsensitive])
func isWakePhrase(_ t: String) -> Bool {
    let r = NSRange(t.startIndex..., in: t)
    return WAKE.firstMatch(in: t, options: [], range: r) != nil || FUSED.firstMatch(in: t, options: [], range: r) != nil
}

final class Ears: NSObject, AVAudioPlayerDelegate {
    enum Mode { case wake, capture, talking }
    var mode: Mode = .wake

    let engine = AVAudioEngine()
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var restartTimer: Timer?
    // Every recognition request gets a generation number, and a callback from
    // an older generation is ignored. Without this the 45 s restart was fatal:
    // cancelling a task makes its handler fire with a "cancelled" error, the
    // handler saw an error and scheduled a restart, the restart cancelled the
    // brand-new task, whose handler fired with an error… four restarts a
    // second, and no request ever lived long enough to hear a word. The first
    // 45 seconds after launch worked; nothing after did. Found the night it
    // shipped, when "Hey Eve" did nothing.
    var generation = 0
    var lastHeardLog = Date.distantPast
    // Rotated tasks, kept alive by generation until their final result has
    // arrived: a task nobody references can be torn down before it finishes,
    // and its final is the whole point of rotating.
    var finishing: [Int: SFSpeechRecognitionTask] = [:]
    // Wake-mode voice activity, for ROTATING the request at the end of each
    // utterance. An on-device request's partial results are rough ("Hey",
    // "AVA") and its FINAL result is good — and a final only arrives when the
    // request is ended. So when the room goes quiet for 0.7 s after speech,
    // the live request is ended (endAudio, never cancel) while a fresh one is
    // already running to take the next words; the old one's final is where
    // "Hey Eve" is most reliably read, within a second of him saying it. A
    // 45 s cap rotates a request that never went quiet.
    var wakeLoud = 0
    var wakeSpoke = false
    var wakeLastLoud = Date.distantPast
    var wakeTimer: Timer?
    // Injection (tests): audio comes from a file, her reply is fetched but not
    // played, and the process exits once the expected wakes have run out.
    var injected = false
    var injectFormat: AVAudioFormat?
    var injectTimer: Timer?
    var bargeFile: URL?
    var wakes = 0
    var wakesExpected = 1

    // 16 kHz mono Int16: the face protocol's one audio format.
    let wire = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    var converter: AVAudioConverter?

    let session = URLSession(configuration: .default)
    var ws: URLSessionWebSocketTask?

    // The voice-activity gate for one utterance. `loudFrames` counts frames
    // above the threshold: speech is a run of them, a pop or a door is one or
    // two. The first 0.6 s after the wake are ignored outright — that is the
    // pop itself, and the tail of him saying the phrase — because on the
    // first live test the pop alone opened a turn and the server transcribed
    // the room's hum as "I want to".
    var captureStarted = Date()
    var lastLoud: Date?
    var heardSpeech = false
    var loudFrames = 0
    var peakRms = 0.0 // the loudest frame this capture saw — logged, so a
                      // "nothing said" can be told from "said too softly"
    var vadTimer: Timer?
    let popGuard: TimeInterval = 0.5 // the pop is ~0.2 s; the tail of the phrase a little more
    let speechFrames = 6 // ~260 ms of voice at 2048-frame 48 kHz buffers
    // 0.012 of full scale. The first cut was 0.03 after the pop alone had
    // opened a turn; with the pop guard and the run-of-frames rule in place
    // that was too deaf — a voice a few metres from the MacBook mic sits
    // around 0.01–0.04, and the second live test heard nothing after the
    // phrase three times running.
    let loudRms = 0.012

    // Her reply: MP3 segments fetched by id, played strictly in sequence.
    var queue: [(seq: Int, data: Data)] = []
    var nextSeq = 0
    var pendingFetches = 0
    var player: AVAudioPlayer?
    var turnDone = false
    // Bumped on every wake, including a barge-in: a segment fetched for the
    // turn she was cut off from must not play into the new one.
    var turnGen = 0
    // The baseTurnId of the reply being played; a turn_done for another base
    // (the interrupted one, arriving late) is not ours.
    var currentBase: String?
    var wakeArmed: Bool { mode == .wake || mode == .talking }

    // ── start ──────────────────────────────────────────────────────────
    func start() throws {
        guard let rec = recognizer, rec.isAvailable else {
            throw NSError(domain: "ears", code: 1, userInfo: [NSLocalizedDescriptionKey: "the en-US speech recogniser is not available"])
        }
        guard rec.supportsOnDeviceRecognition else {
            throw NSError(domain: "ears", code: 2, userInfo: [NSLocalizedDescriptionKey: "on-device recognition is not supported for en-US on this Mac — enable Dictation (English, US) once in System Settings → Keyboard so the model downloads"])
        }
        let input = engine.inputNode
        let native = input.outputFormat(forBus: 0)
        converter = AVAudioConverter(from: native, to: wire)
        input.installTap(onBus: 0, bufferSize: 2048, format: native) { [weak self] buf, _ in
            self?.onBuffer(buf)
        }
        engine.prepare()
        try engine.start()
        wakeTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.wakeTick() }
        startWakeRecognition()
        log("listening for \"Hey Eve\" (on-device, en-US; mic \(Int(native.sampleRate)) Hz)")
    }

    func onBuffer(_ buf: AVAudioPCMBuffer) {
        switch mode {
        case .wake, .talking:
            request?.append(buf)
            wakeLevel(buf)
        case .capture: streamFrame(buf)
        }
    }

    // ── the wake recogniser ────────────────────────────────────────────
    // A level read on the native buffer, for the rotation above.
    func wakeLevel(_ buf: AVAudioPCMBuffer) {
        guard let ch = buf.floatChannelData else { return } // an Int16 mic: no rotation, the 45 s cap still applies
        let n = Int(buf.frameLength)
        if n == 0 { return }
        var acc = 0.0
        for i in 0..<n { let v = Double(ch[0][i]); acc += v * v }
        let rms = (acc / Double(n)).squareRoot()
        DispatchQueue.main.async {
            guard self.wakeArmed else { return }
            if rms > self.loudRms {
                self.wakeLoud += 1
                if self.wakeLoud >= 3 { self.wakeSpoke = true; self.wakeLastLoud = Date() }
            }
        }
    }

    func wakeTick() {
        guard wakeArmed, wakeSpoke, Date().timeIntervalSince(wakeLastLoud) > 0.7 else { return }
        rotateWakeRequest()
    }

    // End the live request so it finalises, with the next one already running.
    func rotateWakeRequest() {
        let old = request
        startWakeRecognition(rotatingFrom: old)
        old?.endAudio()
    }

    // `rotatingFrom`: the request being let finish (its task is NOT cancelled,
    // so its final result still arrives and may wake her). Nil = a plain
    // restart after an error or a mode change, which cancels whatever ran.
    func startWakeRecognition(rotatingFrom old: SFSpeechAudioBufferRecognitionRequest? = nil) {
        generation += 1
        let gen = generation
        if old == nil {
            task?.cancel()
            request?.endAudio()
        } else if let t = task {
            finishing[gen - 1] = t
        }
        task = nil
        wakeSpoke = false
        wakeLoud = 0
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.contextualStrings = ["Hey Eve", "Eve"]
        request = req
        task = recognizer!.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            DispatchQueue.main.async {
                // Any generation may wake her — a rotated request's FINAL is the
                // best read of the phrase — as long as her ears are not already
                // open. Everything else (logging, restarting) is the live
                // generation's alone: a superseded request's last words are
                // usually "cancelled", and acting on them made a restart loop.
                if error != nil || (result?.isFinal ?? false) { self.finishing[gen] = nil }
                if let r = result, self.wakeArmed, isWakePhrase(r.bestTranscription.formattedString) {
                    self.onWake()
                    return
                }
                if let r = result, r.isFinal, gen != self.generation {
                    let heard = r.bestTranscription.formattedString
                    if hasGreeting(heard) { log("final (rotated): \(String(heard.suffix(60)))") }
                }
                if let e = error as NSError?, gen != self.generation, ![216, 301, 1110].contains(e.code) {
                    log("rotated recogniser: \(e.domain) \(e.code) \(e.localizedDescription)")
                }
                guard gen == self.generation, self.wakeArmed else { return }
                if let r = result {
                    let heard = r.bestTranscription.formattedString
                    // Only lines that carry a greeting are logged — that is
                    // what diagnoses a miss — at most every 5 s and cut to 60
                    // chars; the room's other talk stays out of the log.
                    if hasGreeting(heard), Date().timeIntervalSince(self.lastHeardLog) > 5 {
                        self.lastHeardLog = Date()
                        log("hearing\(r.isFinal ? " (final)" : ""): \(String(heard.suffix(60)))")
                    }
                }
                if let e = error as NSError? {
                    // 1110 "no speech detected" and 216/301 cancellations are
                    // routine; anything else is worth reading in the log.
                    if ![216, 301, 1110].contains(e.code) { log("recogniser: \(e.domain) \(e.code) \(e.localizedDescription)") }
                }
                if error != nil || (result?.isFinal ?? false) {
                    // A finished or failed request is simply replaced; the
                    // engine tap keeps feeding whichever request is current.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                        guard let self = self, self.wakeArmed, gen == self.generation else { return }
                        self.startWakeRecognition()
                    }
                }
            }
        }
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
            if self?.wakeArmed == true { self?.rotateWakeRequest() }
        }
    }

    // ── the wake ───────────────────────────────────────────────────────
    func onWake() {
        guard wakeArmed else { return }
        let bargeIn = mode == .talking
        mode = .capture
        wakes += 1
        restartTimer?.invalidate()
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        turnGen += 1
        currentBase = nil
        queue = []; nextSeq = 0; pendingFetches = 0
        turnDone = false

        if bargeIn {
            // Over her voice: stop the sound first, then tell the server —
            // the socket is still the turn's, so the mic reopens on it.
            player?.stop(); player = nil
            log("heard the phrase over her — she stops, and listens")
            send(["type": "interrupt"])
        } else {
            log("heard the phrase — opening her ears")
            let t = session.webSocketTask(with: URL(string: "ws://\(SERVER)/")!)
            ws = t
            t.resume()
            receive()
            send(["type": "client_info", "device": "mac"])
        }
        NSSound(named: NSSound.Name("Pop"))?.play()

        captureStarted = Date()
        lastLoud = nil
        heardSpeech = false
        loudFrames = 0
        peakRms = 0
        send(["type": "mic", "on": true])
        vadTimer?.invalidate()
        vadTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.vadTick() }
    }

    func send(_ obj: [String: Any]) {
        guard let ws = ws, let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        ws.send(.string(String(decoding: data, as: UTF8.self))) { [weak self] err in
            if let err = err {
                DispatchQueue.main.async {
                    log("send failed: \(err.localizedDescription) — is the face server up?")
                    self?.backToWake()
                }
            }
        }
    }

    // Native mic buffer → 16 kHz mono Int16 on the wire, with an RMS reading
    // for the voice-activity gate. One input buffer per convert call.
    func streamFrame(_ buf: AVAudioPCMBuffer) {
        guard let conv = converter, let ws = ws else { return }
        let ratio = wire.sampleRate / buf.format.sampleRate
        let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: cap) else { return }
        var err: NSError?
        var consumed = false
        conv.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        let n = Int(out.frameLength)
        var acc = 0.0
        for i in 0..<n { let v = Double(ch[0][i]) / 32768.0; acc += v * v }
        let rms = (acc / Double(max(n, 1))).squareRoot()
        DispatchQueue.main.async {
            guard Date().timeIntervalSince(self.captureStarted) > self.popGuard else { return }
            if rms > self.peakRms { self.peakRms = rms }
            if rms > self.loudRms {
                self.loudFrames += 1
                if self.loudFrames >= self.speechFrames {
                    self.heardSpeech = true
                    self.lastLoud = Date()
                }
            }
        }
        ws.send(.data(Data(bytes: ch[0], count: n * 2))) { _ in }
    }

    func vadTick() {
        guard mode == .capture else { return }
        let now = Date()
        if heardSpeech, let l = lastLoud, now.timeIntervalSince(l) > 1.2 { endCapture(); return }
        if !heardSpeech, now.timeIntervalSince(captureStarted) > 6 {
            log(String(format: "nothing said after the phrase — never mind (peak level %.3f, gate %.3f)", peakRms, loudRms))
            send(["type": "interrupt"])
            ws?.cancel(with: .normalClosure, reason: nil); ws = nil
            backToWake()
            return
        }
        if now.timeIntervalSince(captureStarted) > 20 { endCapture() }
    }

    func endCapture() {
        vadTimer?.invalidate(); vadTimer = nil
        mode = .talking
        send(["type": "mic", "on": false])
        log(String(format: "sent what he said — waiting for her (peak level %.3f)", peakRms))
        startWakeRecognition() // armed while she answers: "Hey Eve" cuts her off
    }

    // ── her reply ──────────────────────────────────────────────────────
    func receive() {
        ws?.receive { [weak self] res in
            guard let self = self else { return }
            DispatchQueue.main.async {
                switch res {
                case .failure(let e):
                    if self.mode != .wake {
                        log("socket closed: \(e.localizedDescription)")
                        self.backToWake()
                    }
                case .success(let m):
                    if case .string(let s) = m,
                       let d = s.data(using: .utf8),
                       let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                       let type = j["type"] as? String {
                        self.handle(type, j)
                    }
                    self.receive()
                }
            }
        }
    }

    func handle(_ type: String, _ j: [String: Any]) {
        switch type {
        case "heard":
            if (j["interim"] as? Bool) == false { log("heard: \(j["text"] ?? "")") }
        case "state":
            if let s = j["state"] as? String {
                log("state: \(s)")
                if s == "speaking", let b = bargeFile {
                    bargeFile = nil
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.feed(fileAt: b) }
                }
            }
        case "speak_segment":
            guard mode == .talking, let id = j["segId"] as? String, let seq = j["seq"] as? Int else { break }
            if currentBase == nil { currentBase = j["baseTurnId"] as? String }
            if let base = j["baseTurnId"] as? String, base == currentBase { fetchSegment(id, seq) }
        case "turn_done":
            // The interrupted turn's turn_done can arrive after the barge-in;
            // it names its base, and only the base being played counts.
            guard mode == .talking else { break }
            if let base = j["baseTurnId"] as? String, let mine = currentBase, base != mine { break }
            turnDone = true
            drainIfIdle()
        case "turn_error":
            log("turn error: \(j["message"] ?? "")")
            guard mode == .talking else { break } // the cut-off turn's error, mid-capture: not ours
            turnDone = true
            drainIfIdle()
        case "confirm_request":
            log("the gate wants his yes on the face: \(j["intent"] ?? "")")
        default:
            break
        }
    }

    func fetchSegment(_ id: String, _ seq: Int) {
        pendingFetches += 1
        let gen = turnGen
        let url = URL(string: "http://\(SERVER)/tts/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")!
        session.dataTask(with: url) { [weak self] data, _, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard gen == self.turnGen else { return } // she was cut off; this segment is not played
                self.pendingFetches -= 1
                if let d = data, err == nil {
                    self.queue.append((seq, d))
                    self.queue.sort { $0.seq < $1.seq }
                } else {
                    log("segment \(seq) lost: \(err?.localizedDescription ?? "no data")")
                    if seq == self.nextSeq { self.nextSeq += 1 } // never stall on a hole
                }
                self.playNext()
                self.drainIfIdle()
            }
        }.resume()
    }

    func playNext() {
        guard player == nil, let first = queue.first, first.seq == nextSeq else { return }
        queue.removeFirst()
        nextSeq += 1
        if injected {
            log("segment \(first.seq): \(first.data.count) bytes (not played — injection)")
            playNext()
            return
        }
        do {
            let p = try AVAudioPlayer(data: first.data)
            p.delegate = self
            player = p
            p.play()
        } catch {
            log("could not play segment \(first.seq): \(error.localizedDescription)")
            playNext()
        }
    }

    func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            self.player = nil
            self.playNext()
            self.drainIfIdle()
        }
    }

    func drainIfIdle() {
        if mode == .talking, turnDone, player == nil, queue.isEmpty, pendingFetches == 0 {
            ws?.cancel(with: .normalClosure, reason: nil); ws = nil
            log("her reply played out — back to listening")
            backToWake()
        }
    }

    func backToWake() {
        vadTimer?.invalidate(); vadTimer = nil
        player?.stop(); player = nil
        queue = []; nextSeq = 0; pendingFetches = 0; turnDone = false
        currentBase = nil
        mode = .wake
        if injected, wakes >= wakesExpected {
            log("injection: \(wakes) wake(s) ran to completion — done")
            exit(0)
        }
        startWakeRecognition()
    }

    // ── injection ──────────────────────────────────────────────────────
    func startInjected(_ url: URL, barge: URL?) throws {
        guard let rec = recognizer, rec.isAvailable, rec.supportsOnDeviceRecognition else {
            throw NSError(domain: "ears", code: 2, userInfo: [NSLocalizedDescriptionKey: "on-device recognition unavailable"])
        }
        injected = true
        bargeFile = barge
        wakesExpected = barge == nil ? 1 : 2
        let file = try AVAudioFile(forReading: url)
        injectFormat = file.processingFormat
        converter = AVAudioConverter(from: file.processingFormat, to: wire)
        wakeTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.wakeTick() }
        startWakeRecognition()
        log("injecting \(url.lastPathComponent) (\(Int(file.processingFormat.sampleRate)) Hz) into the pipeline — no microphone, nothing played")
        feed(fileAt: url)
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { log("injection: timed out"); exit(2) }
    }

    // Real-time pacing, 2048 frames per tick, exactly what the mic tap does;
    // after the clip, silence in the same format, for as long as it takes.
    func feed(fileAt url: URL) {
        guard let fmt = injectFormat, let file = try? AVAudioFile(forReading: url) else { log("cannot read \(url.path)"); return }
        let frames: AVAudioFrameCount = 2048
        injectTimer?.invalidate()
        injectTimer = Timer.scheduledTimer(withTimeInterval: Double(frames) / fmt.sampleRate, repeats: true) { [weak self] t in
            guard let self = self, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { t.invalidate(); return }
            do { try file.read(into: buf, frameCount: frames) } catch { buf.frameLength = 0 }
            if buf.frameLength == 0 {
                t.invalidate()
                self.feedSilence()
                return
            }
            self.onBuffer(buf)
        }
    }

    func feedSilence() {
        guard let fmt = injectFormat else { return }
        let frames: AVAudioFrameCount = 2048
        injectTimer?.invalidate()
        injectTimer = Timer.scheduledTimer(withTimeInterval: Double(frames) / fmt.sampleRate, repeats: true) { [weak self] _ in
            guard let self = self, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
            buf.frameLength = frames // zeroed on allocation
            self.onBuffer(buf)
        }
    }
}

// ── entry ──────────────────────────────────────────────────────────────
func micState() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not determined (will prompt on first run)"
    @unknown default: return "unknown"
    }
}
func speechState() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not determined (will prompt on first run)"
    @unknown default: return "unknown"
    }
}

// The process entry, called by the stub. Never returns on the agent path
// (the run loop is the process); the test modes exit() themselves.
@_cdecl("ears_main")
public func ears_main() -> Int32 {
    let args = CommandLine.arguments


    if args.contains("--selftest") {
        // Reads only — this never shows a prompt, so it can run from any shell.
        let rec = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        print("microphone permission: \(micState())")
        print("speech permission:     \(speechState())")
        print("recogniser available:  \(rec?.isAvailable ?? false)")
        print("on-device supported:   \(rec?.supportsOnDeviceRecognition ?? false)")
        let sem = DispatchSemaphore(value: 0)
        var server = "unreachable"
        URLSession.shared.dataTask(with: URL(string: "http://\(SERVER)/")!) { _, resp, _ in
            if let r = resp as? HTTPURLResponse { server = "HTTP \(r.statusCode)" }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 3)
        print("face server:           \(server)")
        for t in ["hey eve", "Hey Evie", "hey eva", "Hey, Eve what's today like", "ehi eve", "a eve", "Hey E", "AEVA", "AEVEVA what's today like", "Ava", "hey even so", "hey everyone", "believe me", "eve", "I have a favour to ask"] {
            print("wake matcher \"\(t)\": \(isWakePhrase(t))")
        }
        exit(0)
    }

    if let i = args.firstIndex(of: "--recognize-file"), i + 1 < args.count {
        // Runs the wake matcher on a recording (say -o hey.aiff "Hey Eve") — the
        // one way to test recognition without a room. Needs Speech permission,
        // which macOS attributes to the RESPONSIBLE process: run from a shell that
        // is the terminal (or whatever spawned it), and the call aborts the process
        // with SIGABRT before a line is printed. Launch it through LaunchServices
        // so the app answers for itself:
        //   open -n -W --stdout out.txt --stderr err.txt -a EVE-Ears.app \
        //        --args --recognize-file hey.aiff
        // (A clip that ends the instant the word does may lose its last word —
        // give the file a beat of silence, or say more after the phrase.)
        let url = URL(fileURLWithPath: args[i + 1])
        var last = ""
        if SFSpeechRecognizer.authorizationStatus() != .authorized {
            print("speech permission is \(speechState()) for this build — a dialog must be answered at the screen")
        }
        // The cap lives OUTSIDE the permission callback: the first version put it
        // inside, so a build whose identity macOS had never seen (every ad-hoc
        // rebuild) waited forever for an Allow dialog nobody could click, and the
        // cap never armed.
        DispatchQueue.main.asyncAfter(deadline: .now() + 40) {
            print("no final result in 40 s (last partial: \(last)) — a permission dialog pending, or another process holding the on-device recogniser?")
            print("wake: \(isWakePhrase(last))")
            exit(isWakePhrase(last) ? 0 : 4)
        }
        SFSpeechRecognizer.requestAuthorization { st in
            guard st == .authorized, let rec = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
                print("speech permission: \(speechState())"); exit(3)
            }
            let req = SFSpeechURLRecognitionRequest(url: url)
            req.requiresOnDeviceRecognition = true
            req.contextualStrings = ["Hey Eve", "Eve"]
            rec.recognitionTask(with: req) { result, error in
                if let e = error { print("error: \(e.localizedDescription)"); exit(2) }
                if let r = result {
                    last = r.bestTranscription.formattedString
                    if r.isFinal {
                        print("transcript: \(last)")
                        print("wake: \(isWakePhrase(last))")
                        exit(isWakePhrase(last) ? 0 : 1)
                    }
                }
            }
        }
        RunLoop.main.run()
    }

    if let i = args.firstIndex(of: "--inject-file"), i + 1 < args.count {
        let clip = URL(fileURLWithPath: args[i + 1])
        var barge: URL? = nil
        if let b = args.firstIndex(of: "--barge"), b + 1 < args.count { barge = URL(fileURLWithPath: args[b + 1]) }
        let ears = Ears()
        if SFSpeechRecognizer.authorizationStatus() != .authorized {
            log("speech permission is \(speechState()) for this build — waiting on a dialog that must be answered at the screen")
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { log("injection: no permission after 60 s — giving up"); exit(3) }
        }
        SFSpeechRecognizer.requestAuthorization { st in
            DispatchQueue.main.async {
                guard st == .authorized else { log("speech permission: \(speechState())"); exit(3) }
                do { try ears.startInjected(clip, barge: barge) } catch { log("cannot start: \(error.localizedDescription)"); exit(2) }
            }
        }
        RunLoop.main.run()
    }

    if let i = args.firstIndex(of: "--mic-level"), i + 1 < args.count {
        // The room's noise floor, so the voice gate can be set above it and not
        // above his voice: RMS of full scale per 2048-frame buffer, for N seconds.
        let seconds = Double(args[i + 1]) ?? 5
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            DispatchQueue.main.async {
                guard ok else { print("microphone permission: \(micState())"); exit(3) }
                let engine = AVAudioEngine()
                let input = engine.inputNode
                let fmt = input.outputFormat(forBus: 0)
                var lo = 1.0, hi = 0.0, sum = 0.0, n = 0
                input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { buf, _ in
                    guard let ch = buf.floatChannelData, buf.frameLength > 0 else { return }
                    var acc = 0.0
                    for k in 0..<Int(buf.frameLength) { let v = Double(ch[0][k]); acc += v * v }
                    let rms = (acc / Double(buf.frameLength)).squareRoot()
                    lo = min(lo, rms); hi = max(hi, rms); sum += rms; n += 1
                }
                engine.prepare()
                do { try engine.start() } catch { print("engine: \(error.localizedDescription)"); exit(2) }
                DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                    engine.stop()
                    print(String(format: "mic %@ %.0f Hz — %d buffers over %.0f s: rms min %.4f  mean %.4f  max %.4f", fmt.commonFormat == .pcmFormatFloat32 ? "float32" : "int16", fmt.sampleRate, n, seconds, lo, n > 0 ? sum / Double(n) : 0, hi))
                    exit(0)
                }
            }
        }
        RunLoop.main.run()
    }

    if args.contains("--ws-selftest") {
        // The wire without a microphone: connect, identify, mic on, one second of
        // silence, mic off. The server should answer "couldn't make out anything"
        // — proof that the socket, the frames and the reply path all line up.
        let ears = Ears()
        let t = ears.session.webSocketTask(with: URL(string: "ws://\(SERVER)/")!)
        ears.ws = t
        t.resume()
        var seen: [String] = []
        func pump() {
            t.receive { res in
                if case .success(.string(let s)) = res,
                   let d = s.data(using: .utf8),
                   let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                   let type = j["type"] as? String {
                    seen.append(type)
                    print("<- \(type)\(type == "turn_error" ? ": \(j["message"] ?? "")" : "")")
                    if type == "turn_error" || type == "turn_done" { t.cancel(with: .normalClosure, reason: nil); exit(0) }
                }
                if case .failure(let e) = res { print("socket: \(e.localizedDescription)"); exit(2) }
                pump()
            }
        }
        pump()
        ears.send(["type": "client_info", "device": "mac"])
        ears.send(["type": "mic", "on": true])
        let silence = Data(count: 320 * 2) // 20 ms of 16 kHz mono Int16 zeros
        for i in 0..<50 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.02) { t.send(.data(silence)) { _ in } }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { ears.send(["type": "mic", "on": false]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("timeout; saw: \(seen)"); exit(2) }
        RunLoop.main.run()
    }

    // The real thing: an agent with no UI, asking for its two permissions once.
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let ears = Ears()
    if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized || SFSpeechRecognizer.authorizationStatus() != .authorized {
        log("waiting for permission — microphone: \(micState()); speech: \(speechState()). Answer the dialogs at the screen; nothing is heard until then.")
    }
    AVCaptureDevice.requestAccess(for: .audio) { mic in
        SFSpeechRecognizer.requestAuthorization { st in
            DispatchQueue.main.async {
                guard mic, st == .authorized else {
                    log("permissions missing — microphone: \(micState()); speech: \(speechState()). Grant them in System Settings → Privacy & Security, then kickstart the agent.")
                    sleep(30) // launchd would respawn at once; the prompt was already shown
                    exit(3)
                }
                do { try ears.start() } catch {
                    log("cannot start: \(error.localizedDescription)")
                    sleep(30)
                    exit(2)
                }
            }
        }
    }
    RunLoop.main.run()
    return 0
}


