import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { loadThemes } from './themes.js';

export default class OrbitPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 520);

        const page = new Adw.PreferencesPage({ title: 'Orbit', icon_name: 'preferences-system-symbolic' });

        const themesGroup = new Adw.PreferencesGroup({
            title: 'Theme',
            description: 'Collapsed and expanded state can use different themes. Add your own: drop a small JSON file into ~/.config/orbit/themes/ (format documented in themes.js) and reopen this window.',
        });
        const themes = loadThemes();
        const addThemeCombo = (title, key, sameOption) => {
            const ids = sameOption ? ['same', ...themes.map(t => t.id)] : themes.map(t => t.id);
            const names = sameOption
                ? ['Same as collapsed', ...themes.map(t => t.name || t.id)]
                : themes.map(t => t.name || t.id);
            const row = new Adw.ComboRow({ title, model: Gtk.StringList.new(names) });
            const sync = () => {
                row.selected = Math.max(0, ids.indexOf(settings.get_string(key)));
            };
            sync();
            row.connect('notify::selected', () => {
                const id = ids[row.selected];
                if (id && settings.get_string(key) !== id) settings.set_string(key, id);
            });
            settings.connect(`changed::${key}`, sync);
            themesGroup.add(row);
        };
        addThemeCombo('Collapsed theme', 'theme', false);
        addThemeCombo('Expanded theme', 'theme-open', true);
        page.add(themesGroup);

        const behavior = new Adw.PreferencesGroup({ title: 'Behaviour' });
        behavior.add(this._switch(settings, 'open-on-hover', 'Expand on hover',
            'Open the notch automatically when the pointer is over it.'));
        behavior.add(this._switch(settings, 'show-visualizer', 'Closed-state activity',
            'Show album art and an equaliser hint on the pill while playing.'));
        behavior.add(this._switch(settings, 'accent-from-art', 'Tint from album art',
            'Derive an accent colour from the current art and tint the scrubber.'));
        behavior.add(this._switch(settings, 'enable-gradient', 'Animated album-art gradient',
            'Fill the open popup with a slowly-moving gradient from the album art.'));
        page.add(behavior);

        const hover = new Adw.PreferencesGroup({
            title: 'Hover activation',
            description: 'Dock-style pressure sensitivity: require a deliberate dwell before expanding, so passing the cursor over the notch never triggers it. Clicking always opens instantly.',
        });
        hover.add(this._spin(settings, 'hover-open-delay-ms', 'Open delay (ms)', 0, 2000, 25,
            'How long the pointer must rest on the notch before it expands. 0 expands immediately.'));
        hover.add(this._spin(settings, 'hover-close-delay-ms', 'Close delay (ms)', 0, 2000, 25,
            'Grace period after the pointer leaves before the notch collapses.'));
        hover.add(this._switch(settings, 'hover-hint', 'Pressure hint',
            'Subtly swell the pill while the open delay counts down, so the notch acknowledges the hover.'));
        page.add(hover);

        const vis = new Adw.PreferencesGroup({
            title: 'Visualizer',
            description: 'Real-time equaliser via Cava (requires the cava package).',
        });
        vis.add(this._spin(settings, 'visualizer-bars', 'Bar count', 1, 32));
        vis.add(this._spin(settings, 'visualizer-bar-width', 'Bar width (px)', 1, 8));
        page.add(vis);

        const notif = new Adw.PreferencesGroup({ title: 'Notifications' });
        notif.add(this._switch(settings, 'enable-notifications', 'Notification peeks',
            'Briefly expand the notch when a notification arrives.'));
        notif.add(this._spin(settings, 'notif-peek-seconds', 'Peek duration (s)', 1, 15, 1,
            'The banner stays as long as the pointer is over it.'));
        notif.add(this._spin(settings, 'notif-width', 'Banner width (px)', 300, 700, 10));
        const ignoreRow = new Adw.EntryRow({ title: 'Ignore apps (comma-separated names)' });
        ignoreRow.text = settings.get_strv('notif-ignore-apps').join(', ');
        ignoreRow.connect('changed', () => {
            settings.set_strv('notif-ignore-apps',
                ignoreRow.text.split(',').map(s => s.trim()).filter(Boolean));
        });
        notif.add(ignoreRow);
        page.add(notif);

        const shelf = new Adw.PreferencesGroup({
            title: 'Files shelf',
            description: 'A temporary tray for files. Paste (Ctrl+V) files onto the notch; click a card to paste it back out.',
        });
        shelf.add(this._switch(settings, 'enable-shelf', 'Enable files shelf',
            'Show the shelf tab and let files be pasted into it.'));
        page.add(shelf);

        const lyrics = new Adw.PreferencesGroup({
            title: 'Lyrics',
            description: 'Synced lyrics via lrclib.net. The lyrics button (left of the transport controls) toggles a wide lyrics pill.',
        });
        lyrics.add(this._switch(settings, 'enable-lyrics', 'Enable synced lyrics',
            'Fetch lyrics for the playing song and show the lyrics button.'));
        page.add(lyrics);

        const size = new Adw.PreferencesGroup({
            title: 'Sizes',
            description: 'Changes apply immediately, no reload needed.',
        });
        size.add(this._spin(settings, 'closed-width', 'Collapsed width (px)', 120, 500, 5));
        size.add(this._spin(settings, 'closed-height', 'Collapsed height (px)', 20, 48, 1,
            'Normally follows the top bar height automatically.'));
        size.add(this._spin(settings, 'open-width', 'Expanded width (px)', 500, 1200, 10));
        size.add(this._spin(settings, 'open-height', 'Expanded height (px)', 160, 400, 4));
        size.add(this._spin(settings, 'lyrics-width', 'Lyrics pill width (px)', 300, 700, 10));
        page.add(size);

        const reset = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({
            title: 'Reset all settings',
            subtitle: 'Restore every Orbit option to its default value.',
        });
        const resetBtn = new Gtk.Button({
            label: 'Reset', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'],
        });
        resetBtn.connect('clicked', () => {
            const dlg = new Adw.AlertDialog({
                heading: 'Reset all settings?',
                body: 'Every Orbit option returns to its default. This cannot be undone.',
            });
            dlg.add_response('cancel', 'Cancel');
            dlg.add_response('reset', 'Reset');
            dlg.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.connect('response', (_d, resp) => {
                if (resp !== 'reset') return;
                for (const key of settings.settings_schema.list_keys())
                    settings.reset(key);

                ignoreRow.text = settings.get_strv('notif-ignore-apps').join(', ');
            });
            dlg.present(window);
        });
        resetRow.add_suffix(resetBtn);
        resetRow.set_activatable_widget(resetBtn);
        reset.add(resetRow);
        page.add(reset);

        window.add(page);
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({ title, subtitle });
        settings.bind(key, row, 'active', 0);
        return row;
    }

    _spin(settings, key, title, min, max, step = 1, subtitle = null) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
        });
        if (subtitle) row.subtitle = subtitle;
        settings.bind(key, row, 'value', 0);
        return row;
    }
}
