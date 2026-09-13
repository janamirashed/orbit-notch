import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
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
        this._startBrightnessWatcher();
        this._startPrivacyWatcher();
        this._startBluetoothWatcher();
    }

    // Fallback brightness watcher — GSD Power.Screen PropertiesChanged on session bus.
    // Also tries org.gnome.Mutter.DisplayConfig since GNOME 50 on Wayland can route
    // brightness keys through Mutter directly.
    _startBrightnessWatcher() {
        try {
            this._brightLastLevel = -1;

            const handleBrightness = (pct) => {
                if (pct < 0 || pct > 100) return;
                if (pct === this._brightLastLevel) return;
                this._brightLastLevel = pct;
                if (this._notch) this._notch.showHud('brightness', pct / 100, null);
            };

            // Listen on session bus for any PropertiesChanged containing brightness
            this._brightSubId = Gio.DBus.session.signal_subscribe(
                null,
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                null,
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _sig, params) => {
                    try {
                        const [ifaceName, changedProps] = params.deep_unpack();
                        // GSD Power.Screen  (common in GNOME <50)
                        if (ifaceName === 'org.gnome.SettingsDaemon.Power.Screen') {
                            const bv = changedProps['Brightness'];
                            if (bv != null) handleBrightness(bv.deep_unpack());
                        }
                        // Shell's own brightness control (GNOME 45+)
                        if (ifaceName === 'org.gnome.Shell.Introspect' ||
                            ifaceName === 'org.gnome.SettingsDaemon.Power') {
                            const bv = changedProps['Brightness'] ?? changedProps['ScreenBrightness'];
                            if (bv != null) handleBrightness(bv.deep_unpack());
                        }
                    } catch (_) {}
                }
            );

            // Also poll via GSD async call to seed the initial value and verify connectivity
            Gio.DBus.session.call(
                'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', [
                    'org.gnome.SettingsDaemon.Power.Screen', 'Brightness',
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                1500,
                null,
                (conn, res) => {
                    try {
                        const result = conn.call_finish(res);
                        const pct = result.deep_unpack()[0].deep_unpack();
                        handleBrightness(pct);
                    } catch (_) {}
                }
            );
        } catch (e) {
            logError(e, 'OrbitDynamicIsland: brightness watcher failed to start');
        }
    }

    _stopBrightnessWatcher() {
        if (this._brightSubId) {
            Gio.DBus.session.signal_unsubscribe(this._brightSubId);
            this._brightSubId = 0;
        }
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

        const parseOsdCall = (icon, level, maxLevel) => {
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
                if (re.test(name)) {
                    // Compute 0-1 fraction.  GNOME may pass (level=0.65, maxLevel=1)
                    // or (level=65, maxLevel=100) — divide by maxLevel when present.
                    let frac = null;
                    if (level != null && level >= 0) {
                        // GNOME ShowOSD sends level as 0-1 float; maxLevel is often absent
                        // (arrives as -1). Only divide when maxLevel is sensibly > 1.
                        const max = (maxLevel != null && maxLevel > 1) ? maxLevel : 1;
                        frac = Math.max(0, Math.min(1, level / max));
                    }
                    return { type, value: frac };
                }
            }
            return null;
        };

        const routeOsd = (icon, level, maxLevel) => {
            const matched = parseOsdCall(icon, level, maxLevel);
            if (!matched) return false;
            try {
                if (self._notch) self._notch.showHud(matched.type, matched.value);
                return true;
            } catch (e) {
                logError(e, 'OrbitDynamicIsland: showHud failed, falling back to system OSD');
                return false;   // let system OSD show
            }
        };

        // GNOME 49+ has showOne / showAll; earlier has show
        if (osd.showOne) {
            osd.showOne = function(monitorIndex, icon, label, level, maxLevel) {
                if (routeOsd(icon, level, maxLevel)) return;
                self._origOsdShowOne.call(osd, monitorIndex, icon, label, level, maxLevel);
            };
        }
        if (osd.showAll) {
            osd.showAll = function(icon, label, level, maxLevel) {
                if (routeOsd(icon, level, maxLevel)) return;
                self._origOsdShowAll.call(osd, icon, label, level, maxLevel);
            };
        }
        // Always-present fallback
        osd.show = function(monitorIndex, icon, label, level, maxLevel) {
            if (routeOsd(icon, level, maxLevel)) return;
            self._origOsdShow.call(osd, monitorIndex, icon, label, level, maxLevel);
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
        this._stopBrightnessWatcher();
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
