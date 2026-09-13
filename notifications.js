import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const OrbitNotifications = GObject.registerClass({
    Signals: {
        'arrived': { param_types: [GObject.TYPE_JSOBJECT] },
        'changed': {},
    },
}, class OrbitNotifications extends GObject.Object {
    _init(settings = null) {
        super._init();
        this._settings = settings;
        this._items = [];
        this._sourceAddedId = 0;
        this._sourceConns = new Map();
        this._seq = 0;
    }

    start() {
        const tray = Main.messageTray;
        if (!tray) return;
        this._sourceAddedId = tray.connect('source-added', (_t, s) => this._track(s));
        for (const s of tray.getSources()) this._track(s);
    }

    stop() {
        if (this._sourceAddedId) {
            try { Main.messageTray.disconnect(this._sourceAddedId); } catch (e) {}
            this._sourceAddedId = 0;
        }
        for (const [source, rec] of this._sourceConns) {
            try { if (rec.addedId) source.disconnect(rec.addedId); } catch (e) {}
            try { if (rec.destroyId) source.disconnect(rec.destroyId); } catch (e) {}
        }
        this._sourceConns.clear();
        for (const it of this._items) this._unhook(it);
        this._items = [];
    }

    _unhook(item) {
        if (item.destroyId) {
            try { item.notif.disconnect(item.destroyId); } catch (e) {}
            item.destroyId = 0;
        }
    }

    _track(source) {
        if (this._sourceConns.has(source)) return;

        if (source.constructor?.name === 'WindowAttentionSource') return;
        const addedId = source.connect('notification-added', (_s, n) => this._onNotif(source, n));
        const destroyId = source.connect('destroy', () => {
            const rec = this._sourceConns.get(source);
            try { if (rec?.addedId) source.disconnect(rec.addedId); } catch (e) {}
            this._sourceConns.delete(source);
        });
        this._sourceConns.set(source, { addedId, destroyId });
    }

    _onNotif(source, n) {
        const appName = (source && source.title) || '';

        if (this._settings) {
            const ignored = this._settings.get_strv('notif-ignore-apps');
            const low = appName.toLowerCase();
            if (ignored.some(x => x.trim().toLowerCase() === low)) return;
        }
        let gicon = null;
        try {
            // Check if notification itself has an image/icon
            gicon = n.gicon || n.icon || null;

            // If appName is specified, check if it matches a specific PWA or desktop app
            const candidates = [appName, source?.title, source?.name].filter(Boolean);
            const appSys = Shell.AppSystem.get_default();

            if (appSys && candidates.length) {
                const installed = appSys.get_installed();
                for (const raw of candidates) {
                    const norm = raw.toLowerCase().trim();
                    if (!norm || norm === 'chromium' || norm === 'google chrome' || norm === 'brave') continue;

                    let matched = installed.find(a => a.get_name()?.toLowerCase() === norm);
                    if (!matched) {
                        matched = installed.find(a => {
                            const aname = a.get_name()?.toLowerCase();
                            return aname && (norm.includes(aname) || aname.includes(norm));
                        });
                    }
                    if (!matched) {
                        matched = installed.find(a => {
                            const aid = a.get_id()?.toLowerCase() ?? '';
                            return aid.includes(norm);
                        });
                    }
                    if (matched) {
                        const icon = matched.get_icon();
                        if (icon) {
                            gicon = icon;
                            break;
                        }
                    }
                }
            }

            // Source fallbacks
            if (!gicon) gicon = source?.icon || source?.gicon || null;
            if (!gicon && source?.app) gicon = source.app.get_icon();
            if (!gicon && source?.getIcon) gicon = source.getIcon();
            if (!gicon && n.iconName) gicon = Gio.ThemedIcon.new(n.iconName);
            if (!gicon && source?.iconName) gicon = Gio.ThemedIcon.new(source.iconName);
        } catch (e) {}
        const item = {
            id: ++this._seq,
            appName,
            title: n.title || '',
            body: n.body || '',
            gicon,
            time: new Date(),
            notif: n,
            destroyId: 0,
        };

        item.destroyId = n.connect('destroy', () => {
            item.destroyId = 0;
            const idx = this._items.indexOf(item);
            if (idx >= 0) {
                this._items.splice(idx, 1);
                if (!this._bulk) this.emit('changed');
            }
        });
        this._items.unshift(item);
        while (this._items.length > 30) this._unhook(this._items.pop());
        this.emit('arrived', item);
        this.emit('changed');
    }

    getRecent() { return this._items; }

    getGroups() {
        const map = new Map();
        for (const item of this._items) {
            const key = item.appName || 'Notifications';
            let g = map.get(key);
            if (!g) {
                g = { key, appName: key, gicon: item.gicon, time: item.time, items: [] };
                map.set(key, g);
            }
            g.items.push(item);
        }
        return [...map.values()];
    }

    _destroyItems(items) {
        this._bulk = true;
        for (const it of items) {
            if (it.notif) { try { it.notif.destroy(); } catch (e) {} }

            const idx = this._items.indexOf(it);
            if (idx >= 0) { this._unhook(it); this._items.splice(idx, 1); }
        }
        this._bulk = false;
        this.emit('changed');
    }

    clearGroup(appName) {
        const key = appName || 'Notifications';
        this._destroyItems(this._items.filter(i => (i.appName || 'Notifications') === key));
    }

    clear() { this._destroyItems([...this._items]); }

    activate(item) {
        try { item?.notif?.activate?.(); } catch (e) {}
    }
});
