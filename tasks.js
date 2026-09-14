import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TASKS_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'orbit', 'tasks.json']);

export const OrbitTasks = GObject.registerClass({
    Signals: { 'changed': {} },
}, class OrbitTasks extends GObject.Object {
    _init() {
        super._init();
        this._tasks = [];
        this._load();
    }

    tasks() {
        return this._tasks;
    }

    add(text) {
        const title = (text || '').trim();
        if (!title) return;
        this._tasks.unshift({
            id: Date.now().toString(),
            title,
            done: false,
            createdAt: Date.now(),
        });
        this._save();
        this.emit('changed');
    }

    toggle(id) {
        const task = this._tasks.find(t => t.id === id);
        if (!task) return;
        task.done = !task.done;
        this._save();
        this.emit('changed');
    }

    remove(id) {
        const idx = this._tasks.findIndex(t => t.id === id);
        if (idx < 0) return;
        this._tasks.splice(idx, 1);
        this._save();
        this.emit('changed');
    }

    clearCompleted() {
        this._tasks = this._tasks.filter(t => !t.done);
        this._save();
        this.emit('changed');
    }

    _load() {
        const file = Gio.File.new_for_path(TASKS_FILE);
        file.load_contents_async(null, (f, res) => {
            let raw;
            try { [, raw] = f.load_contents_finish(res); } catch (_) { return; }
            try {
                const arr = JSON.parse(new TextDecoder().decode(raw));
                if (Array.isArray(arr)) {
                    this._tasks = arr;
                    this.emit('changed');
                }
            } catch (_) {}
        });
    }

    _save() {
        const parent = GLib.path_get_dirname(TASKS_FILE);
        GLib.mkdir_with_parents(parent, 0o755);
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._tasks)));
        Gio.File.new_for_path(TASKS_FILE).replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (file, res) => {
                try { file.replace_contents_finish(res); } catch (_) {}
            }
        );
    }
});
