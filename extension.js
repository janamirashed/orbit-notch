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
                        if (typeof pct === 'number' && pct >= 0)
                            this._brightLastLevel = pct;
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
        this._origOsdShowOsdWindow = osd._showOsdWindow ?? null;

        const self = this;

        // Symbols that indicate volume/brightness actions
        const hudIconPatterns = [
            { re: /audio-volume|audio-speaker|microphone-sensitivity/i, type: 'volume' },
            { re: /brightness/i, type: 'brightness' },
        ];

        const parseOsdCall = (icon, level, maxLevel) => {
            let name = '';
            if (icon) {
                if (typeof icon === 'string')
                    name = icon;
                else if (typeof icon.icon_name === 'string' && icon.icon_name)
                    name = icon.icon_name;
                else if (typeof icon.get_names === 'function')
                    name = icon.get_names()?.[0] ?? '';
                else if (typeof icon.get_icon_name === 'function')
                    name = icon.get_icon_name() ?? '';
                else if (typeof icon.to_string === 'function')
                    name = icon.to_string() ?? '';
            }
            for (const { re, type } of hudIconPatterns) {
                if (re.test(name)) {
                    let frac = null;
                    if (level != null && level >= 0) {
                        if (level > 1) {
                            const max = (maxLevel != null && maxLevel > 1) ? maxLevel : 100;
                            frac = Math.max(0, Math.min(1, level / max));
                        } else {
                            frac = Math.max(0, Math.min(1, level));
                        }
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

        // GNOME 50 show signature is: show(icon, label, levels)
        // Earlier GNOME signature: show(monitorIndex, icon, label, level, maxLevel)
        osd.show = function(...args) {
            let icon = null, level = null, maxLevel = null;
            if (typeof args[0] === 'number') {
                // Older GNOME: (monitorIndex, icon, label, level, maxLevel)
                [, icon, , level, maxLevel] = args;
            } else {
                // GNOME 50+: (icon, label, levels)
                [icon] = args;
                const levels = args[2];
                if (levels && typeof levels === 'object') {
                    const primary = Main.layoutManager.primaryIndex ?? 0;
                    const entry = levels[primary] ?? Object.values(levels)[0];
                    level = entry?.level ?? null;
                    maxLevel = entry?.maxLevel ?? null;
                }
            }
            if (routeOsd(icon, level, maxLevel)) return;
            self._origOsdShow.apply(osd, args);
        };

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
        if (osd._showOsdWindow) {
            osd._showOsdWindow = function(monitorIndex, icon, label, level, maxLevel) {
                if (routeOsd(icon, level, maxLevel)) return;
                self._origOsdShowOsdWindow.call(osd, monitorIndex, icon, label, level, maxLevel);
            };
        }
    }

    _restoreOsd() {
        const osd = Main.osdWindowManager;
        if (!osd) return;
        if (this._origOsdShow) { osd.show = this._origOsdShow; this._origOsdShow = null; }
        if (this._origOsdShowOne) { osd.showOne = this._origOsdShowOne; this._origOsdShowOne = null; }
        if (this._origOsdShowAll) { osd.showAll = this._origOsdShowAll; this._origOsdShowAll = null; }
        if (this._origOsdShowOsdWindow) { osd._showOsdWindow = this._origOsdShowOsdWindow; this._origOsdShowOsdWindow = null; }
    }

    _suppressSystemBanners() {
        const enabled = this._settings.get_boolean('enable-notifications');
        const tray = Main.messageTray;
        if (!tray) return;

        if (enabled) {
            tray.bannerBlocked = true;
            if (tray._bannerBin) {
                tray._bannerBin.opacity = 0;
                tray._bannerBin.visible = false;
            }
        } else {
            this._restoreSystemBanners();
        }
    }

    _restoreSystemBanners() {
        const tray = Main.messageTray;
        if (!tray) return;
        tray.bannerBlocked = false;
        if (tray._bannerBin) {
            tray._bannerBin.opacity = 255;
            tray._bannerBin.visible = true;
        }
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
