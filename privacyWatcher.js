/**
 * privacyWatcher.js
 * Watches microphone capture (via Gvc) and camera access (via /proc scan).
 * Emits 'changed' (micActive: bool, camActive: bool) whenever state flips.
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let Gvc = null;
try { Gvc = (await import('gi://Gvc')).default; } catch (e) {}

// ── Camera detection via /proc/*/fd symlinks to /dev/video* ──────────────────
function isCameraInUse() {
    try {
        const devDir = Gio.File.new_for_path('/dev');
        const en = devDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        const videoDev = new Set();
        while ((info = en.next_file(null)))
            if (/^video\d+$/.test(info.get_name())) videoDev.add(`/dev/${info.get_name()}`);
        if (videoDev.size === 0) return false;

        const procDir = Gio.File.new_for_path('/proc');
        const pen = procDir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let pinfo;
        while ((pinfo = pen.next_file(null))) {
            if (pinfo.get_file_type() !== Gio.FileType.DIRECTORY) continue;
            const pid = pinfo.get_name();
            if (!/^\d+$/.test(pid)) continue;
            const fdPath = `/proc/${pid}/fd`;
            try {
                const fden = Gio.File.new_for_path(fdPath).enumerate_children(
                    'standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let fi;
                while ((fi = fden.next_file(null))) {
                    try {
                        const target = Gio.File.new_for_path(`${fdPath}/${fi.get_name()}`)
                            .read_link(null);
                        if (videoDev.has(target)) return true;
                    } catch (_) {}
                }
            } catch (_) {}
        }
    } catch (_) {}
    return false;
}

// ── PrivacyWatcher ────────────────────────────────────────────────────────────
export const PrivacyWatcher = GObject.registerClass({
    GTypeName: 'OrbitPrivacyWatcher',
    Signals: {
        'changed': { param_types: [GObject.TYPE_BOOLEAN, GObject.TYPE_BOOLEAN] },
    },
}, class PrivacyWatcher extends GObject.Object {

    _init() {
        super._init();
        this._micActive = false;
        this._camActive = false;

        // Microphone via Gvc MixerControl
        if (Gvc) {
            this._control = new Gvc.MixerControl({ name: 'orbit-privacy' });
            this._streamAddedId   = this._control.connect('stream-added',   (c) => this._onStreamChanged(c));
            this._streamRemovedId = this._control.connect('stream-removed',  (c) => this._onStreamChanged(c));
            this._stateId         = this._control.connect('state-changed',   (c) => this._onStreamChanged(c));
            this._control.open();
        }

        // Camera via /proc poll every 3 s
        this._camPollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._pollCamera();
            return GLib.SOURCE_CONTINUE;
        });
        this._pollCamera();
    }

    get micActive() { return this._micActive; }
    get camActive()  { return this._camActive;  }

    _onStreamChanged(control) {
        let outputs = [];
        try { outputs = control.get_source_outputs() ?? []; } catch (_) {}

        // Source outputs are apps capturing from mic; exclude event/monitor streams
        const active = outputs.some(s => {
            try { return !s.is_event_stream; } catch (_) { return true; }
        });

        if (active !== this._micActive) {
            this._micActive = active;
            this.emit('changed', this._micActive, this._camActive);
        }
    }

    _pollCamera() {
        const active = isCameraInUse();
        if (active !== this._camActive) {
            this._camActive = active;
            this.emit('changed', this._micActive, this._camActive);
        }
    }

    destroy() {
        if (this._camPollId) { GLib.Source.remove(this._camPollId); this._camPollId = 0; }
        if (this._control) {
            if (this._streamAddedId)   this._control.disconnect(this._streamAddedId);
            if (this._streamRemovedId) this._control.disconnect(this._streamRemovedId);
            if (this._stateId)         this._control.disconnect(this._stateId);
            this._control.close();
            this._control = null;
        }
    }
});
