import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';

const MPRIS_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek"><arg direction="in" type="x" name="Offset"/></method>
    <signal name="Seeked"><arg type="x" name="Position"/></signal>
  </interface>
</node>`;

function unpack(v) {
    if (v instanceof GLib.Variant) return v.deepUnpack();
    return v;
}

export const OrbitMediaController = GObject.registerClass({
    Signals: { 'changed': {} },
}, class OrbitMediaController extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._proxies = new Map();
        this._lastActionTime = 0;
        this._lastWinnerName = null;
        this._artCache = new Map();
        this._artMeta = new Map();
        this._cancellable = new Gio.Cancellable();

        this._soup = new Soup.Session();
        this._artDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'orbit', 'art']);
        GLib.mkdir_with_parents(this._artDir, 0o755);

        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(MPRIS_IFACE);
        this._ifaceInfo = nodeInfo.interfaces.find(
            i => i.name === 'org.mpris.MediaPlayer2.Player');
    }

    start() {
        this._connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        this._ownerId = this._connection.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            () => this._scan());
        this._scan();
    }

    stop() {
        this._cancellable.cancel();
        if (this._connection && this._ownerId) {
            this._connection.signal_unsubscribe(this._ownerId);
            this._ownerId = null;
        }
        for (const name of [...this._proxies.keys()]) this._removeProxy(name);
        this._proxies.clear();
        this._artCache.clear();
    }

    _scan() {
        if (!this._connection) return;
        this._connection.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                let names;
                try { names = conn.call_finish(res).deepUnpack()[0]; }
                catch (e) { return; }
                const mpris = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
                let changed = false;
                for (const n of mpris) {
                    if (!this._proxies.has(n)) { this._add(n); changed = true; }
                }
                for (const n of [...this._proxies.keys()]) {
                    if (!mpris.includes(n)) { this._removeProxy(n); changed = true; }
                }
                if (changed) this.emit('changed');
            });
    }

    _add(name) {
        if (this._proxies.has(name)) return;
        Gio.DBusProxy.new(
            this._connection, Gio.DBusProxyFlags.NONE, this._ifaceInfo,
            name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player',
            this._cancellable, (src, res) => {
                let p;
                try { p = Gio.DBusProxy.new_finish(res); }
                catch (e) { return; }
                p._busName = name;
                p._lastPosition = 0;
                p._lastPositionTime = Date.now();
                p._lastPlayingTime = p.PlaybackStatus === 'Playing' ? Date.now() : 0;
                p._lastTrackId = null;

                p._propId = p.connect('g-properties-changed', (proxy, changedProps) => {
                    const keys = changedProps.deepUnpack();
                    const now = Date.now();
                    if (keys.PlaybackStatus) {
                        if (unpack(keys.PlaybackStatus) === 'Playing') p._lastPlayingTime = now;
                    }
                    if (keys.Metadata) {
                        const m = unpack(keys.Metadata);
                        const tid = m['mpris:trackid'] ? unpack(m['mpris:trackid']) : null;
                        if (tid && tid !== p._lastTrackId) {
                            p._lastTrackId = tid;
                            p._lastPosition = 0;
                            p._lastPositionTime = now;
                            this._syncPosition(p);
                        }
                    }
                    if (keys.Position !== undefined) {
                        const v = unpack(keys.Position);
                        if (typeof v === 'number' && v >= 0) {
                            p._lastPosition = v; p._lastPositionTime = now;
                        }
                    }
                    this.emit('changed');
                });
                p._seekedId = p.connectSignal('Seeked', (proxy, sender, [pos]) => {
                    if (typeof pos === 'number' && pos >= 0) {
                        p._lastPosition = pos; p._lastPositionTime = Date.now();
                    }
                    this.emit('changed');
                });

                this._proxies.set(name, p);
                this._syncPosition(p);
                this.emit('changed');
            });
    }

    _removeProxy(name) {
        const p = this._proxies.get(name);
        if (!p) return;
        if (p._propId) p.disconnect(p._propId);
        if (p._seekedId) p.disconnectSignal(p._seekedId);
        this._proxies.delete(name);
    }

    _syncPosition(p) {
        if (!this._connection) return;
        this._connection.call(
            p._busName, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties',
            'Get', new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    const val = unpack(conn.call_finish(res).deepUnpack()[0]);
                    if (typeof val === 'number' && val >= 0) {
                        p._lastPosition = val; p._lastPositionTime = Date.now();
                        this.emit('changed');
                    }
                } catch (e) {  }
            });
    }

    getActivePlayer() {
        const arr = [...this._proxies.values()];
        if (arr.length === 0) return null;

        if (Date.now() - this._lastActionTime < 3000 && this._lastWinnerName) {
            const locked = arr.find(p => p._busName === this._lastWinnerName);
            if (locked) return locked;
        }

        const scored = arr.map(p => {
            let score = 0, hasTitle = false;
            try {
                const m = p.Metadata ? unpack(p.Metadata) : null;
                hasTitle = !!(m && m['xesam:title'] && unpack(m['xesam:title']));
            } catch (e) {}
            if (p.PlaybackStatus === 'Playing' && hasTitle) score = 500;
            else if (p.PlaybackStatus === 'Paused' && hasTitle) score = 100;
            return { p, score };
        }).sort((a, b) =>
            b.score !== a.score ? b.score - a.score
                                : b.p._lastPlayingTime - a.p._lastPlayingTime);

        if (scored[0].score <= 0) return null;
        this._lastWinnerName = scored[0].p._busName;
        return scored[0].p;
    }

    getState() {
        const p = this.getActivePlayer();
        if (!p) return { hasPlayer: false };

        let title = '', artist = '', artUrl = '', lengthUs = 0;
        try {
            const m = p.Metadata ? unpack(p.Metadata) : {};
            title = m['xesam:title'] ? unpack(m['xesam:title']) : '';
            let a = m['xesam:artist'] ? unpack(m['xesam:artist']) : '';
            artist = Array.isArray(a) ? a.join(', ') : a;
            artUrl = m['mpris:artUrl'] ? unpack(m['mpris:artUrl']) : '';
            lengthUs = m['mpris:length'] ? Number(unpack(m['mpris:length'])) : 0;
        } catch (e) {}

        const status = p.PlaybackStatus || 'Stopped';
        let positionUs = p._lastPosition;
        if (status === 'Playing')
            positionUs += (Date.now() - p._lastPositionTime) * 1000;
        if (lengthUs > 0) positionUs = Math.min(positionUs, lengthUs);

        return {
            hasPlayer: true,
            title, artist, artUrl, status,
            lengthUs, positionUs,
            canGoNext: p.CanGoNext ?? true,
            canGoPrev: p.CanGoPrevious ?? true,
            canSeek: p.CanSeek ?? false,
            color: this._artCache.get(artUrl) || null,
        };
    }

    playPause() { const p = this.getActivePlayer(); if (p) p.PlayPauseRemote(); }
    next()      { this._lastActionTime = Date.now(); const p = this.getActivePlayer(); if (p) p.NextRemote(); }
    previous()  { this._lastActionTime = Date.now(); const p = this.getActivePlayer(); if (p) p.PreviousRemote(); }

    seekRelative(offsetUs) {
        const p = this.getActivePlayer();
        if (!p) return;
        this._connection.call(
            p._busName, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player',
            'Seek', new GLib.Variant('(x)', [offsetUs]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => { try { conn.call_finish(res); } catch (e) {} });
    }

    seekAbsolute(positionUs) {
        const p = this.getActivePlayer();
        if (!p) return;
        let trackId = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
        try {
            const m = p.Metadata ? unpack(p.Metadata) : null;
            if (m && m['mpris:trackid']) trackId = unpack(m['mpris:trackid']);
        } catch (e) {}

        p._lastPosition = positionUs;
        p._lastPositionTime = Date.now();
        this._connection.call(
            p._busName, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player',
            'SetPosition', new GLib.Variant('(ox)', [trackId, Math.round(positionUs)]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => { try { conn.call_finish(res); } catch (e) {} });
        this.emit('changed');
    }

    ensureColor(artUrl, onColor) {
        if (!artUrl) return;
        if (this._artCache.has(artUrl)) { onColor(this._artCache.get(artUrl)); return; }
        if (!artUrl.startsWith('file://')) return;
        const path = Gio.File.new_for_uri(artUrl).get_path();
        if (!path) return;

        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            try {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 128, 128, true);
                const color = this._averageColor(pb);
                this._artCache.set(artUrl, color);
                if (this._artCache.size > 50)
                    this._artCache.delete(this._artCache.keys().next().value);
                onColor(color);
            } catch (e) {  }
            return GLib.SOURCE_REMOVE;
        });
    }

    _averageColor(pb) {
        const w = pb.get_width(), h = pb.get_height();
        const px = pb.get_pixels();
        const stride = pb.get_rowstride();
        const ch = pb.get_n_channels();
        let r = 0, g = 0, b = 0, count = 0;
        for (let y = 0; y < h; y += 8) {
            for (let x = 0; x < w; x += 8) {
                const i = y * stride + x * ch;
                r += px[i]; g += px[i + 1]; b += px[i + 2]; count++;
            }
        }
        return { r: Math.floor(r / count), g: Math.floor(g / count), b: Math.floor(b / count) };
    }

    _resolveContainerPath(rawPath) {
        if (GLib.file_test(rawPath, GLib.FileTest.EXISTS))
            return rawPath;

        const p = this.getActivePlayer();
        const candidatePids = new Set();

        if (p?._busName) {
            const m = p._busName.match(/instance(\d+)/);
            if (m) candidatePids.add(parseInt(m[1], 10));

            try {
                const res = this._connection.call_sync(
                    'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                    'GetConnectionUnixProcessID',
                    new GLib.Variant('(s)', [p._busName]),
                    null, Gio.DBusCallFlags.NONE, 500, null
                );
                if (res) {
                    const [pid] = res.deep_unpack();
                    if (pid) candidatePids.add(pid);
                }
            } catch (_) {}
        }

        // Expand candidate PIDs to include their children
        for (const pid of [...candidatePids]) {
            try {
                const [, childData] = GLib.file_get_contents(`/proc/${pid}/task/${pid}/children`);
                if (childData) {
                    const str = new TextDecoder().decode(childData);
                    for (const c of str.trim().split(/\s+/)) {
                        const cpid = parseInt(c, 10);
                        if (cpid) candidatePids.add(cpid);
                    }
                }
            } catch (_) {}
        }

        for (const pid of candidatePids) {
            const procPath = `/proc/${pid}/root${rawPath}`;
            if (GLib.file_test(procPath, GLib.FileTest.EXISTS))
                return procPath;
        }

        // Check running user processes if still not found
        try {
            const dir = Gio.File.new_for_path('/proc');
            const enumerator = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!/^\d+$/.test(name)) continue;
                const procPath = `/proc/${name}/root${rawPath}`;
                if (GLib.file_test(procPath, GLib.FileTest.EXISTS))
                    return procPath;
            }
        } catch (_) {}

        return null;
    }

    ensureArtwork(artUrl, onMeta) {
        if (!artUrl) return;
        if (this._artMeta.has(artUrl)) { onMeta(this._artMeta.get(artUrl)); return; }

        if (artUrl.startsWith('file://')) {
            let path = Gio.File.new_for_uri(artUrl).get_path();
            if (!path) return;

            const resolved = this._resolveContainerPath(path);
            if (!resolved) return;

            // Cache in _artDir if reading from a container/proc path
            if (resolved.startsWith('/proc/')) {
                try {
                    const [, bytes] = GLib.file_get_contents(resolved);
                    if (bytes && bytes.length > 0) {
                        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, artUrl, -1);
                        const cachedPath = GLib.build_filenamev([this._artDir, `${hash}.img`]);
                        GLib.file_set_contents(cachedPath, bytes);
                        path = cachedPath;
                    } else {
                        path = resolved;
                    }
                } catch (_) {
                    path = resolved;
                }
            } else {
                path = resolved;
            }

            try {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 160, 160, true);
                this._store(artUrl, { path, palette: this._palette(pb) }, onMeta);
            } catch (e) {}
            return;
        }

        if (artUrl.startsWith('data:')) {
            try {
                const commaIdx = artUrl.indexOf(',');
                if (commaIdx > 0) {
                    const b64 = artUrl.substring(commaIdx + 1);
                    const bytes = GLib.base64_decode(b64);
                    if (bytes && bytes.length > 0) {
                        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, artUrl, -1);
                        const path = GLib.build_filenamev([this._artDir, `${hash}.img`]);
                        GLib.file_set_contents(path, bytes);
                        const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
                        const pb = GdkPixbuf.Pixbuf.new_from_stream_at_scale(stream, 160, 160, true, null);
                        this._store(artUrl, { path, palette: this._palette(pb) }, onMeta);
                        return;
                    }
                }
            } catch (e) {}
            return;
        }

        if (!/^https?:\/\//.test(artUrl)) return;

        try {
            const msg = Soup.Message.new('GET', artUrl);
            if (!msg) return;
            msg.request_headers.append(
                'User-Agent',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );
            this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    if (!bytes || bytes.get_size() === 0) return;
                    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, artUrl, -1);
                    const path = GLib.build_filenamev([this._artDir, `${hash}.img`]);
                    GLib.file_set_contents(path, bytes.get_data());
                    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
                    const pb = GdkPixbuf.Pixbuf.new_from_stream_at_scale(stream, 160, 160, true, null);
                    this._store(artUrl, { path, palette: this._palette(pb) }, onMeta);
                } catch (e) {}
            });
        } catch (e) {}
    }

    _store(artUrl, meta, onMeta) {
        this._artMeta.set(artUrl, meta);
        this._artCache.set(artUrl, meta.palette.base);
        if (this._artMeta.size > 40) this._artMeta.delete(this._artMeta.keys().next().value);
        onMeta(meta);
    }

    _palette(pb) {
        const w = pb.get_width(), h = pb.get_height();
        const px = pb.get_pixels(), stride = pb.get_rowstride(), ch = pb.get_n_channels();
        const quad = (x0, x1, y0, y1) => {
            let r = 0, g = 0, b = 0, n = 0;
            for (let y = y0; y < y1; y += 6)
                for (let x = x0; x < x1; x += 6) {
                    const i = y * stride + x * ch;
                    r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
                }
            n = n || 1;
            return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
        };
        const hw = w >> 1, hh = h >> 1;
        return {
            base: quad(0, w, 0, h),
            colors: [
                quad(0, hw, 0, hh), quad(hw, w, 0, hh),
                quad(0, hw, hh, h), quad(hw, w, hh, h),
            ],
        };
    }
});
