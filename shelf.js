import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'orbit', 'shelf']);
const INDEX = GLib.build_filenamev([CACHE_DIR, 'index.json']);

export const OrbitShelf = GObject.registerClass({
    Signals: { 'changed': {} },
}, class OrbitShelf extends GObject.Object {
    _init() {
        super._init();
        this._items = [];
        this._seq = 0;
    }

    start() {
        this._stopped = false;
        GLib.mkdir_with_parents(CACHE_DIR, 0o755);
        this._load();
    }

    stop() {
        this._stopped = true;
    }

    items() { return this._items; }
    count() { return this._items.length; }

    _load() {
        Gio.File.new_for_path(INDEX).load_contents_async(null, (file, res) => {
            if (this._stopped) return;
            let raw;
            try { [, raw] = file.load_contents_finish(res); } catch (e) { return; }
            let arr;
            try { arr = JSON.parse(new TextDecoder().decode(raw)); } catch (e) { return; }
            if (!Array.isArray(arr)) return;
            let added = false;
            for (const e of arr) {
                if (!e || !e.path) continue;
                if (!GLib.file_test(e.path, GLib.FileTest.EXISTS)) continue;
                this._items.push(this._makeItem(e.path, !!e.owned));
                added = true;
            }
            if (added) this.emit('changed');
        });
    }

    _save() {
        const arr = this._items.map(i => ({ path: i.path, owned: i.owned }));
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(arr)));
        Gio.File.new_for_path(INDEX).replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (file, res) => {
                try { file.replace_contents_finish(res); } catch (e) {}
            });
    }

    _makeItem(path, owned) {
        const [type] = Gio.content_type_guess(path, null);
        let uri = '';
        try { uri = GLib.filename_to_uri(path, null); } catch (e) {}
        return {
            id: `s${this._seq++}`,
            path,
            uri,
            name: GLib.path_get_basename(path),
            owned,
            isImage: !!type && type.startsWith('image/'),
            contentType: type || 'application/octet-stream',
        };
    }

    _has(path) { return this._items.some(i => i.path === path); }

    addPaths(paths) {
        let added = false;
        for (const p of paths) {
            if (!p || this._has(p)) continue;
            if (!GLib.file_test(p, GLib.FileTest.EXISTS)) continue;
            this._items.push(this._makeItem(p, false));
            added = true;
        }
        if (added) { this._save(); this.emit('changed'); }
        return added;
    }

    addUris(uris) {
        const paths = [];
        for (const u of uris) {
            if (!u || !u.startsWith('file://')) continue;
            try { paths.push(GLib.filename_from_uri(u)[0]); } catch (e) {}
        }
        return this.addPaths(paths);
    }

    addImageBytes(bytes, ext) {
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        const name = `paste-${stamp}-${this._seq}.${ext || 'png'}`;
        const path = GLib.build_filenamev([CACHE_DIR, name]);
        Gio.File.new_for_path(path).replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (file, res) => {
                try { file.replace_contents_finish(res); } catch (e) { return; }
                if (this._stopped) return;
                this._items.push(this._makeItem(path, true));
                this._save();
                this.emit('changed');
            });
    }

    remove(id) {
        const idx = this._items.findIndex(i => i.id === id);
        if (idx < 0) return;
        const it = this._items[idx];
        this._items.splice(idx, 1);
        if (it.owned) {
            try { Gio.File.new_for_path(it.path).delete(null); } catch (e) {}
        }
        this._save();
        this.emit('changed');
    }

    clear() {
        for (const it of this._items)
            if (it.owned) { try { Gio.File.new_for_path(it.path).delete(null); } catch (e) {} }
        this._items = [];
        this._save();
        this.emit('changed');
    }
});
