import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { OrbitMediaController } from './mediaController.js';
import { OrbitNotch } from './notch.js';
import { SharedVisualizerEngine } from './visualizer.js';

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

        this._applyBannerBlock();
        this._notifToggleId = this._settings.connect('changed::enable-notifications',
            () => this._applyBannerBlock());

        this._place();
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());

        this._panelAllocId = Main.panel.connect('notify::height', () => this._place());
    }

    _applyBannerBlock() {
        if (Main.messageTray)
            Main.messageTray.bannerBlocked = this._settings.get_boolean('enable-notifications');
    }

    _place() {
        if (!this._notch) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        this._notch.setMonitor(monitor);
        const panelH = Main.panel.height || Main.layoutManager.panelBox.height;
        if (panelH > 0) this._notch.setPanelHeight(panelH);
    }

    disable() {
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

        if (Main.messageTray) Main.messageTray.bannerBlocked = false;
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
