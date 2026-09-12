import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { OrbitMediaController } from './mediaController.js';
import { OrbitNotch } from './notch.js';
import { SharedVisualizerEngine } from './visualizer.js';
import { PrivacyWatcher } from './privacyWatcher.js';
import { BluetoothWatcher } from './bluetoothWatcher.js';

export default class OrbitExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._media = new OrbitMediaController(this._settings);
        this._media.start();

        this._notch = new OrbitNotch(this._settings, this._media, () => this.openPreferences());
        Main.layoutManager.addTopChrome(this._notch, {
            trackFullscreen: true,
            affectsStruts: false,
        });

        this._dateMenu = null;

        this._suppressSystemBanners();
        this._notifToggleId = this._settings.connect('changed::enable-notifications',
            () => this._suppressSystemBanners());

        this._place();
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());

        this._panelAllocId = Main.panel.connect('notify::height', () => this._place());

        this._fullscreenId = global.display.connect('in-fullscreen-changed', () => this._updateFullscreen());

        this._interceptOsd();
        this._startPrivacyWatcher();
        this._startBluetoothWatcher();
    }

    _startPrivacyWatcher() {
        try {
            this._privacy = new PrivacyWatcher();
            this._privacyId = this._privacy.connect('changed', (_w, mic, cam) => {
                if (this._notch) this._notch.setPrivacyState(mic, cam);
            });
        } catch (e) {
            logError(e, 'OrbitDynamicIsland: privacy watcher failed to start');
        }
    }

    _stopPrivacyWatcher() {
        if (this._privacy) {
            if (this._privacyId) { this._privacy.disconnect(this._privacyId); this._privacyId = 0; }
            this._privacy.destroy();
            this._privacy = null;
        }
    }

    _startBluetoothWatcher() {
        try {
            this._bt = new BluetoothWatcher();

            this._btConnectId = this._bt.connect('device-connected', (_w, name, battery) => {
                if (!this._notch) return;
                // Build label: "AirPods Pro  •  82%" or just device name
                const label = battery >= 0
                    ? `${name}  •  ${battery}%`
                    : name;
                this._notch.showHud('bluetooth-connect', null, label);
            });

            this._btDisconnectId = this._bt.connect('device-disconnected', (_w, name) => {
                if (!this._notch) return;
                this._notch.showHud('bluetooth-disconnect', null, name);
            });
        } catch (e) {
            logError(e, 'OrbitDynamicIsland: bluetooth watcher failed to start');
        }
    }

    _stopBluetoothWatcher() {
        if (this._bt) {
            if (this._btConnectId)    { this._bt.disconnect(this._btConnectId);    this._btConnectId = 0; }
            if (this._btDisconnectId) { this._bt.disconnect(this._btDisconnectId); this._btDisconnectId = 0; }
            this._bt.destroy();
            this._bt = null;
        }
    }

    // Suppress GNOME's built-in volume/brightness OSD and route to our notch HUD.
    _interceptOsd() {
        const osd = Main.osdWindowManager;
        if (!osd) return;

        // Save original show methods
        this._origOsdShow = osd.show;
        this._origOsdShowOne = osd.showOne ?? null;
        this._origOsdShowAll = osd.showAll ?? null;

        const self = this;

        // Symbols that indicate volume/brightness actions
        const hudIconPatterns = [
            { re: /audio-volume|audio-speaker|microphone-sensitivity/, type: 'volume' },
            { re: /display-brightness|screen-brightness|keyboard-brightness/, type: 'brightness' },
        ];

        const parseOsdCall = (icon, level) => {
            // GNOME passes Gio.ThemedIcon (has get_names()), not a plain string.
            // Fall through multiple APIs until we get something.
            let name = '';
            if (icon) {
                if (typeof icon.icon_name === 'string' && icon.icon_name)
                    name = icon.icon_name;                          // St.Icon / plain obj
                else if (typeof icon.get_names === 'function')
                    name = icon.get_names()?.[0] ?? '';             // Gio.ThemedIcon ← real path
                else if (typeof icon.get_icon_name === 'function')
                    name = icon.get_icon_name() ?? '';
                else if (typeof icon.to_string === 'function')
                    name = icon.to_string() ?? '';
            }
            for (const { re, type } of hudIconPatterns) {
                if (re.test(name)) return { type, value: level != null ? level / 100 : null };
            }
            return null;
        };

        const routeOsd = (icon, level) => {
            const matched = parseOsdCall(icon, level);
            if (!matched) return false;            // not ours — let system handle it
            if (self._notch) self._notch.showHud(matched.type, matched.value);
            return true;
        };

        // GNOME 49+ has showOne / showAll; earlier has show
        if (osd.showOne) {
            osd.showOne = function(monitorIndex, icon, label, level) {
                if (routeOsd(icon, level)) return;
                self._origOsdShowOne.call(osd, monitorIndex, icon, label, level);
            };
        }
        if (osd.showAll) {
            osd.showAll = function(icon, label, level) {
                if (routeOsd(icon, level)) return;
                self._origOsdShowAll.call(osd, icon, label, level);
            };
        }
        // Older path always present
        osd.show = function(monitorIndex, icon, label, level) {
            if (routeOsd(icon, level)) return;
            self._origOsdShow.call(osd, monitorIndex, icon, label, level);
        };
    }

    _restoreOsd() {
        const osd = Main.osdWindowManager;
        if (!osd) return;
        if (this._origOsdShow) { osd.show = this._origOsdShow; this._origOsdShow = null; }
        if (this._origOsdShowOne) { osd.showOne = this._origOsdShowOne; this._origOsdShowOne = null; }
        if (this._origOsdShowAll) { osd.showAll = this._origOsdShowAll; this._origOsdShowAll = null; }
    }

    _suppressSystemBanners() {
        const enabled = this._settings.get_boolean('enable-notifications');
        const tray = Main.messageTray;
        if (!tray) return;

        if (enabled) {
            // Block GNOME's floating banner in two ways for robustness across versions:
            // 1. The documented property (GNOME <45)
            tray.bannerBlocked = true;

            // 2. Patch _showNotification directly (GNOME 45+ redesign)
            if (tray._showNotification && !this._origShowNotif) {
                this._origShowNotif = tray._showNotification.bind(tray);
                // Suppress only the *banner popup* — notification still lands in tray
                tray._showNotification = () => {};
            }
        } else {
            this._restoreSystemBanners();
        }
    }

    _restoreSystemBanners() {
        const tray = Main.messageTray;
        if (!tray) return;
        tray.bannerBlocked = false;
        if (this._origShowNotif) {
            tray._showNotification = this._origShowNotif;
            this._origShowNotif = null;
        }
    }

    _updateFullscreen() {
        if (!this._notch) return;
        const monitor = Main.layoutManager.primaryMonitor;
        const inFs = monitor ? monitor.inFullscreen : false;
        this._notch.visible = !inFs;
    }

    _place() {
        if (!this._notch) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        this._notch.setMonitor(monitor);
        const panelH = Main.panel.height || Main.layoutManager.panelBox.height;
        if (panelH > 0) this._notch.setPanelHeight(panelH);
        this._updateFullscreen();
    }

    disable() {
        if (this._fullscreenId) {
            global.display.disconnect(this._fullscreenId);
            this._fullscreenId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._panelAllocId) {
            Main.panel.disconnect(this._panelAllocId);
            this._panelAllocId = 0;
        }
        if (this._dateMenu) {
            this._dateMenu.container.show();
            this._dateMenu = null;
        }
        if (this._notifToggleId) {
            this._settings.disconnect(this._notifToggleId);
            this._notifToggleId = 0;
        }

        this._restoreOsd();
        this._restoreSystemBanners();
        this._stopPrivacyWatcher();
        this._stopBluetoothWatcher();
        if (this._notch) {
            Main.layoutManager.removeChrome(this._notch);
            this._notch.destroy();
            this._notch = null;
        }
        if (this._media) {
            this._media.stop();
            this._media = null;
        }
        SharedVisualizerEngine.destroy();
        this._settings = null;
    }
}
