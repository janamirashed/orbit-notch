import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const BUILTIN_THEMES = [
    {
        id: 'notch',
        name: 'Orbit',
        fill: '#000000',
    },
    {
        id: 'gnome',
        name: 'GNOME',

        fill: '#353535fa',
    },
    {
        id: 'blur',
        name: 'Blur (Blur my Shell)',

        fill: '#14141473',
        blur: true,
    },
];

const THEME_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'orbit', 'themes']);

export function parseFill(v, fb = [0, 0, 0, 1]) {
    try {
        if (typeof v === 'string' && v.startsWith('#')) {
            const hex = v.slice(1);
            const n = s => parseInt(s, 16) / 255;
            if (hex.length >= 6) {
                return [n(hex.slice(0, 2)), n(hex.slice(2, 4)), n(hex.slice(4, 6)),
                        hex.length >= 8 ? n(hex.slice(6, 8)) : 1];
            }
        }
        if (Array.isArray(v) && v.length >= 3)
            return [v[0] / 255, v[1] / 255, v[2] / 255, v.length > 3 ? Number(v[3]) : 1];
    } catch (e) {}
    return fb;
}

export function loadThemes() {
    const themes = [...BUILTIN_THEMES];
    let en;
    try {
        en = Gio.File.new_for_path(THEME_DIR)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) { return themes; }
    let info;
    while ((info = en.next_file(null))) {
        const fname = info.get_name();
        if (!fname.endsWith('.json')) continue;
        try {
            const [, raw] = GLib.file_get_contents(GLib.build_filenamev([THEME_DIR, fname]));
            const t = JSON.parse(new TextDecoder().decode(raw));
            if (t && typeof t.id === 'string' && !themes.some(x => x.id === t.id))
                themes.push({ name: t.id, ...t });
        } catch (e) {}
    }
    return themes;
}

export function getTheme(id) {
    const themes = loadThemes();
    const t = themes.find(x => x.id === id) ?? themes[0];
    return { ...t, fillRgba: parseFill(t.fill) };
}

export function getBlurParams(theme) {
    const out = {
        radius: theme.blurRadius ?? 30,
        brightness: theme.blurBrightness ?? 0.6,
    };
    if (theme.blurRadius != null && theme.blurBrightness != null) return out;
    try {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(),
            'gnome-shell', 'extensions', 'blur-my-shell@aunetx', 'schemas']);
        if (!GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS))
            return out;
        const src = Gio.SettingsSchemaSource.new_from_directory(
            dir, Gio.SettingsSchemaSource.get_default(), false);
        const rootSch = src.lookup('org.gnome.shell.extensions.blur-my-shell', false);
        if (!rootSch) return out;
        const root = new Gio.Settings({ settings_schema: rootSch });

        let pid = 'pipeline_default';
        const panelSch = src.lookup('org.gnome.shell.extensions.blur-my-shell.panel', false);
        if (panelSch && panelSch.has_key('pipeline'))
            pid = new Gio.Settings({ settings_schema: panelSch }).get_string('pipeline');

        if (rootSch.has_key('pipelines')) {
            const pipes = root.get_value('pipelines').recursiveUnpack();
            const pipe = pipes[pid] ?? Object.values(pipes)[0];
            for (const eff of pipe?.effects ?? []) {
                if (!String(eff?.type ?? '').includes('gaussian_blur')) continue;
                if (theme.blurRadius == null && typeof eff.params?.radius === 'number')
                    out.radius = eff.params.radius;
                if (theme.blurBrightness == null && typeof eff.params?.brightness === 'number')
                    out.brightness = eff.params.brightness;
                return out;
            }
        }

        if (theme.blurRadius == null && rootSch.has_key('sigma')) {
            const sigma = root.get_int('sigma');
            if (sigma > 0) out.radius = 2 * sigma;
        }
        if (theme.blurBrightness == null && rootSch.has_key('brightness'))
            out.brightness = root.get_double('brightness');
    } catch (e) {}
    return out;
}
