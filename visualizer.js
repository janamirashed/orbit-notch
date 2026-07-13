import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import cairo from 'gi://cairo';

export class SharedVisualizerEngine {
    static _instance = null;
    static get() { return (this._instance ||= new SharedVisualizerEngine()); }
    static destroy() { if (this._instance) { this._instance.stopCava(); this._instance = null; } }

    constructor() {
        this._subscribers = new Map();
        this._cavaProcess = false;
        this._fixedBarCount = 64;
        this._bins = new Array(this._fixedBarCount).fill(0);
        this._silentFrames = 30;
        this._rollingMax = 2000;
    }

    subscribe(cb) { if (!this._subscribers.has(cb)) this._subscribers.set(cb, false); this._evaluate(); }
    unsubscribe(cb) { this._subscribers.delete(cb); this._evaluate(); }
    setPlaying(cb, playing) { if (this._subscribers.has(cb)) { this._subscribers.set(cb, playing); this._evaluate(); } }

    _evaluate() {
        let anyPlaying = false;
        for (const p of this._subscribers.values()) if (p) { anyPlaying = true; break; }
        if (anyPlaying) { if (!this._cavaProcess) this.startCava(); }
        else { this.stopCava(); this._broadcast(new Array(this._fixedBarCount).fill(0), true); }
    }

    startCava() {
        if (this._cavaProcess) return;
        try {
            if (!GLib.find_program_in_path('cava')) return;
            const tmp = `${GLib.get_tmp_dir()}/orbit-cava-${GLib.get_monotonic_time()}`;
            const cfg =
                `[general]\nbars = ${this._fixedBarCount}\nframerate = 60\nautosens = 1\n` +
                `lower_cutoff_freq = 50\nhigher_cutoff_freq = 8000\n` +
                `[smoothing]\nmonstercat = 1.5\nwaves = 0\nnoise_reduction = 60\ngravity = 140\n` +
                `[input]\nmethod = pulse\nsource = auto\n` +
                `[output]\nmethod = raw\nbit_format = 16bit\nchannels = mono\nraw_target = /dev/stdout\n`;
            GLib.file_set_contents(tmp, new TextEncoder().encode(cfg));
            this._tmpConfigPath = tmp;

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
            this._process = launcher.spawnv(['cava', '-p', tmp]);
            this._stdout = this._process.get_stdout_pipe();
            this._cancellable = new Gio.Cancellable();
            this._bufferUsed = 0;
            this._rawBuffer = new Uint8Array(8192);
            this._cavaProcess = true;
            this._read();
        } catch (e) {
            console.error('[Orbit] cava: ' + e.message);
        }
    }

    _read() {
        if (!this._stdout || !this._cancellable || this._cancellable.is_cancelled()) return;
        const readSize = Math.max(4096, this._fixedBarCount * 2 * 4);
        this._stdout.read_bytes_async(readSize, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            try {
                const gbytes = stream.read_bytes_finish(res);
                if (!gbytes) return;
                const chunk = gbytes.get_data();
                if (!chunk || chunk.length === 0) { this._read(); return; }

                const needed = this._bufferUsed + chunk.length;
                if (needed > this._rawBuffer.length) {
                    const nb = new Uint8Array(Math.max(needed, this._rawBuffer.length * 2));
                    nb.set(this._rawBuffer.subarray(0, this._bufferUsed));
                    this._rawBuffer = nb;
                }
                this._rawBuffer.set(chunk, this._bufferUsed);
                this._bufferUsed += chunk.length;

                const frameSize = this._fixedBarCount * 2;
                const totalFrames = Math.floor(this._bufferUsed / frameSize);
                if (totalFrames > 0) {
                    const lastOff = (totalFrames - 1) * frameSize;
                    const dv = new DataView(this._rawBuffer.buffer, this._rawBuffer.byteOffset + lastOff, frameSize);
                    let frameMax = 1;
                    for (let i = 0; i < this._fixedBarCount; i++) {
                        const v = dv.getUint16(i * 2, true);
                        this._bins[i] = v;
                        if (v > frameMax) frameMax = v;
                    }
                    if (frameMax < 100) this._silentFrames++; else this._silentFrames = 0;

                    const out = new Array(this._fixedBarCount).fill(0);
                    if (this._silentFrames >= 30) {
                        this._rollingMax = 2000;
                    } else {
                        this._rollingMax = frameMax > this._rollingMax
                            ? frameMax : this._rollingMax * 0.98 + frameMax * 0.02;
                        const inv = 1 / Math.max(this._rollingMax, 5000);
                        for (let i = 0; i < this._fixedBarCount; i++)
                            out[i] = Math.min(1.0, this._bins[i] * inv);
                    }
                    this._broadcast(out, this._silentFrames >= 30);

                    this._rawBuffer.copyWithin(0, totalFrames * frameSize, this._bufferUsed);
                    this._bufferUsed -= totalFrames * frameSize;
                }
                this._read();
            } catch (e) {  }
        });
    }

    _broadcast(data, silent) { for (const cb of this._subscribers.keys()) cb(data, silent); }

    stopCava() {
        if (this._cancellable) { this._cancellable.cancel(); this._cancellable = null; }
        if (this._process) { try { this._process.force_exit(); } catch (e) {} this._process = null; }
        if (this._stdout) { try { this._stdout.close(null); } catch (e) {} this._stdout = null; }
        if (this._tmpConfigPath) {
            try { const f = Gio.File.new_for_path(this._tmpConfigPath); if (f.query_exists(null)) f.delete(null); } catch (e) {}
            this._tmpConfigPath = null;
        }
        this._cavaProcess = false;
        this._silentFrames = 30;
    }
}

export const OrbitVisualizer = GObject.registerClass(
class OrbitVisualizer extends St.DrawingArea {
    _init(settings) {
        super._init({ y_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.FILL });
        this._settings = settings;
        this._colorR = 1; this._colorG = 1; this._colorB = 1;
        this._isSilent = true;
        this._updateBarCount();

        this._barsId = settings.connect('changed::visualizer-bars', () => this._updateBarCount());
        this._bwId = settings.connect('changed::visualizer-bar-width', () => this._updateBarCount());

        this.connect('repaint', () => this._onRepaint());
        this.connect('destroy', () => this._cleanup());

        this._engine = SharedVisualizerEngine.get();
        this._cb = this._onEngineUpdate.bind(this);
        this._engine.subscribe(this._cb);
    }

    _updateBarCount() {
        this._barCount = this._settings.get_int('visualizer-bars') || 8;
        this._barWidth = this._settings.get_int('visualizer-bar-width') || 1;
        this._gap = 2;
        this._prevHeights = new Array(this._barCount).fill(1);
        this._peaks = new Array(this._barCount).fill(0);
        this.set_width(this._barCount * (this._barWidth + this._gap) - this._gap);
        this.queue_repaint();
    }

    setColor(c) {

        const lift = v => Math.min(255, (v ?? 255) + 100) / 255;
        this._colorR = lift(c?.r); this._colorG = lift(c?.g); this._colorB = lift(c?.b);
        this.queue_repaint();
    }

    setPlaying(playing) {
        this._engine.setPlaying(this._cb, playing);
        if (!playing) { this._prevHeights.fill(1); this._peaks.fill(0); this._isSilent = true; this.queue_repaint(); }
    }

    _resample(raw, n) {
        if (raw.length === n) return raw;
        const out = new Array(n).fill(0);
        const ratio = raw.length / n;
        for (let i = 0; i < n; i++) {
            const s = Math.floor(i * ratio), e = Math.floor((i + 1) * ratio);
            let sum = 0, cnt = 0;
            for (let j = s; j < e && j < raw.length; j++) { sum += raw[j]; cnt++; }
            out[i] = cnt > 0 ? sum / cnt : 0;
        }
        return out;
    }

    _onEngineUpdate(bars, silent) {
        if (!this.mapped || (this.is_finalized && this.is_finalized())) return;
        this._isSilent = silent;
        const my = this._resample(bars, this._barCount);
        const half = (this.get_height() || 24) / 2;
        for (let i = 0; i < this._barCount; i++) {
            let target = Math.max(1, Math.round(Math.pow(my[i], 0.8) * half));
            if (!silent && my[i] > 0 && target < 3) target = 3;
            const prev = this._prevHeights[i];
            const alpha = target < prev ? 0.6 : 0.95;
            this._prevHeights[i] = Math.round(prev * (1 - alpha) + target * alpha);
            if (this._prevHeights[i] > this._peaks[i]) this._peaks[i] = this._prevHeights[i];
            else this._peaks[i] -= this._peaks[i] * 0.06;
        }
        this.queue_repaint();
    }

    _onRepaint() {
        const cr = this.get_context();
        const w = this.get_width(), h = this.get_height();
        if (w <= 0 || h <= 0) { cr.$dispose(); return; }
        cr.setOperator(cairo.Operator.CLEAR); cr.paint();
        cr.setOperator(cairo.Operator.OVER);

        const bw = this._barWidth, gap = this._gap, centerY = Math.floor(h / 2);
        for (let i = 0; i < this._barCount; i++) {
            const half = Math.max(1, this._prevHeights[i]);
            const x = i * (bw + gap);
            const edgeFade = 1 - (Math.abs(i - (this._barCount - 1) / 2) / ((this._barCount - 1) / 2 || 1)) * 0.35;
            const a = (this._isSilent ? 0.3 : 1.0) * edgeFade;
            cr.setSourceRGBA(this._colorR, this._colorG, this._colorB, a);
            cr.rectangle(x, centerY - half, bw, half * 2);
            cr.fill();
            if (!this._isSilent) {
                const peak = Math.max(1, this._peaks[i]);
                cr.setSourceRGBA(this._colorR, this._colorG, this._colorB, a * 0.55);
                cr.rectangle(x, centerY - peak - 1, bw, 1); cr.fill();
                cr.rectangle(x, centerY + peak, bw, 1); cr.fill();
            }
        }
        cr.$dispose();
    }

    _cleanup() {
        if (this._barsId) this._settings.disconnect(this._barsId);
        if (this._bwId) this._settings.disconnect(this._bwId);
        this._engine.unsubscribe(this._cb);
    }
});
