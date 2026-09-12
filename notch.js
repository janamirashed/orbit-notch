import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import UPowerGlib from 'gi://UPowerGlib';
import Shell from 'gi://Shell';
import cairo from 'gi://cairo';

// mutter 48+ ships a blur library whose background mode can round its own
// corners; older shells fall back to the square Shell.BlurEffect
let Blur = null;
try {
    Blur = (await import('gi://Blur')).default;
} catch (e) {}

import { OrbitSpringAnimator, SPRINGS } from './spring.js';
import { getTheme, getBlurParams } from './themes.js';
import { OrbitCalendar } from './calendar.js';
import { OrbitVisualizer } from './visualizer.js';
import { OrbitNotifications } from './notifications.js';
import { OrbitShelf } from './shelf.js';
import { LyricsClient } from './lyricsClient.js';
import { OrbitLyricsWidget } from './lyricsWidget.js';

const NOTIF_H = 76;
const HUD_W = 260;
const LYR_H = 40;
const ART_CLOSED = 20;
const ART_OPEN = 90;

const RADIUS = { closed: { top: 0, bottom: 12 }, open: { top: 19, bottom: 24 } };

const HINT_GROW_W = 16;
const HINT_GROW_H = 4;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));

export const OrbitNotch = GObject.registerClass(
class OrbitNotch extends St.Widget {
    _init(settings, media, openPrefs) {
        super._init({
            style_class: 'orbit',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this._settings = settings;
        this._media = media;
        this._openPrefsCb = openPrefs || null;
        this._transientTimeouts = new Set();
        this._monitor = null;
        this._open = false;
        this._openFrac = 0;
        this._rTop = RADIUS.closed.top;
        this._rBottom = RADIUS.closed.bottom;
        this._accent = null;

        this._expMode = 'home';
        this._openTimer = 0;
        this._hinting = false;
        this._view = 'media';
        this._peeking = false;
        this._hudActive = false;
        this._hudTimer = 0;
        this._lastChargingState = undefined;
        this._unread = false;
        this._expandedGroups = new Set();
        this._expandedItems = new Set();

        this._baseCw = settings.get_int('closed-width');
        this._baseCh = settings.get_int('closed-height');
        this._cw = this._baseCw;
        this._ch = this._baseCh;

        this._openW = settings.get_int('open-width');
        this._openH = settings.get_int('open-height');
        this._notifW = settings.get_int('notif-width');
        this._lyrW = settings.get_int('lyrics-width');
        this._sizeIds = ['closed-width', 'closed-height', 'open-width',
            'open-height', 'notif-width', 'lyrics-width']
            .map(k => settings.connect(`changed::${k}`, () => this._onSizesChanged()));

        this._lyricsClient = new LyricsClient();
        this._lyrics = null;
        this._lyricsMode = false;
        this._lyricsToken = 0;
        this._lyricsTimer = 0;
        this._trackKey = null;

        this._anim = new OrbitSpringAnimator(this);

        this._calendar = new OrbitCalendar();
        this._calendar.start();
        this._calId = this._calendar.connect('updated', () => {
            if (this._openLayer.opacity > 0) this._renderCalendar();
        });

        this._dndSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });

        this._notifications = new OrbitNotifications(settings);
        this._notifications.start();
        this._notifArrivedId = this._notifications.connect('arrived', (_n, item) => {

            if (this._dndSettings.get_boolean('show-banners')) {
                this._unread = true;
                this._updateClosedDot();
            }
            this._showPeek(item);
        });
        this._notifChangedId = this._notifications.connect('changed', () => {
            if (this._view === 'notifs' && this._openLayer.opacity > 0) this._renderNotifList();
        });

        this._shelf = new OrbitShelf();
        this._shelf.start();
        this._pasteTarget = null;
        this._shelfChangedId = this._shelf.connect('changed', () => {
            this._updateShelfBadge();
            if (this._view === 'shelf' && this._openLayer.opacity > 0) this._renderShelf();
        });

        try {
            this._upower = UPowerGlib.Client.new_full(null);
            this._battId = this._upower.connect('notify::display-device', () => this._updateBattery());
        } catch (e) { this._upower = null; }

        this._buildShape();
        this._buildGradient();
        this._buildClosedLayer();
        this._buildOpenLayer();
        this._buildNotifLayer();
        this._buildHudLayer();
        this._applyTheme();
        this._themeIds = ['theme', 'theme-open']
            .map(k => settings.connect(`changed::${k}`, () => this._applyTheme()));
        this._updateBattery();
        this._renderCalendar();

        this.set_size(this._cw, this._ch);
        this._applyGeom(this._cw, this._ch);

        this._hoverId = this.connect('notify::hover', () => this._onHover());
        this.connect('button-press-event', () => this._onClick());
        this._mediaId = this._media.connect('changed', () => this._onMediaChanged());

        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });

        this.connect('destroy', () => this._onDestroy());
        this._onMediaChanged();
    }

    setMonitor(monitor) { this._monitor = monitor; this._reposition(); }

    setPanelHeight(h) {
        if (h <= 0 || h === this._baseCh) return;
        this._baseCh = h;
        this._refreshClosedSize();
    }

    _lyricsActive() {
        return this._lyricsMode && this._lyrics && this._lyrics.length > 0;
    }

    _onSizesChanged() {
        this._baseCw = this._settings.get_int('closed-width');
        this._baseCh = this._settings.get_int('closed-height');
        this._openW = this._settings.get_int('open-width');
        this._openH = this._settings.get_int('open-height');
        this._notifW = this._settings.get_int('notif-width');
        this._lyrW = this._settings.get_int('lyrics-width');
        const active = this._lyricsActive();
        this._cw = active ? this._lyrW : this._baseCw;
        this._ch = this._baseCh;
        if (this._open) this._animateGeom(this._openW, this._openH, SPRINGS.open);
        else if (this._peeking) this._animateGeom(this._notifW, Math.max(this._ch, NOTIF_H), SPRINGS.peek);
        else this._animateGeom(this._cw, this._ch, SPRINGS.close);
    }

    _refreshClosedSize() {
        const active = this._lyricsActive();
        const w = active ? this._lyrW : this._baseCw;
        const h = this._baseCh;
        if (w === this._cw && h === this._ch) return;
        this._cw = w;
        this._ch = h;
        if (!this._open) {
            this.set_size(this._cw, this._ch);
            this._applyGeom(this._cw, this._ch);
        }
    }

    _applyTheme() {
        const closed = getTheme(this._settings.get_string('theme'));
        const openId = this._settings.get_string('theme-open');
        const open = openId === 'same' ? closed : getTheme(openId);
        this._themeClosed = closed;
        this._themeOpen = open;

        const styleFor = t => t.text ? `color: ${t.text};` : null;
        this._closedLayer.set_style(styleFor(closed));
        if (this._lyricsLayer) this._lyricsLayer.set_style(styleFor(closed));
        this._openLayer.set_style(styleFor(open));
        if (this._notifLayer) this._notifLayer.set_style(styleFor(open));

        this.remove_effect_by_name('orbit-blur');
        this._blurFx = null;
        const blurTheme = closed.blur ? closed : (open.blur ? open : null);
        if (blurTheme) {
            const p = getBlurParams(blurTheme);
            const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            if (Blur) {
                this._blurFx = new Blur.BlurEffect({
                    mode: Blur.BlurMode.BACKGROUND,
                    radius: p.radius * sf,
                    brightness: p.brightness,
                    corner_radius: this._rBottom * sf,
                });
            } else {
                this._blurFx = new Shell.BlurEffect({
                    mode: Shell.BlurMode.BACKGROUND,
                    radius: p.radius * sf,
                    brightness: p.brightness,
                });
            }
            this.add_effect_with_name('orbit-blur', this._blurFx);
        }

        this._shape.queue_repaint();
        if (this._gradient) this._gradient.queue_repaint();
    }

    _fillNow() {
        const a = this._themeClosed?.fillRgba ?? [0, 0, 0, 1];
        const b = this._themeOpen?.fillRgba ?? a;
        const f = clamp01(this._expFrac ?? 0);
        return [lerp(a[0], b[0], f), lerp(a[1], b[1], f),
                lerp(a[2], b[2], f), lerp(a[3], b[3], f)];
    }

    _buildShape() {
        this._shape = new St.DrawingArea({ x_expand: true, y_expand: true });
        this._shape.connect('repaint', area => this._drawShape(area));
        this.add_child(this._shape);
    }

    _drawShape(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const rt = Math.min(this._rTop, w / 2, h / 2);
        const rb = Math.min(this._rBottom, w / 2, h / 2);

        cr.newSubPath();
        cr.arc(rt, rt, rt, Math.PI, 1.5 * Math.PI);
        cr.arc(w - rt, rt, rt, 1.5 * Math.PI, 2 * Math.PI);
        cr.arc(w - rb, h - rb, rb, 0, 0.5 * Math.PI);
        cr.arc(rb, h - rb, rb, 0.5 * Math.PI, Math.PI);
        cr.closePath();

        const [fr, fg, fb, fa] = this._fillNow();
        cr.setSourceRGBA(fr, fg, fb, fa);
        cr.fill();
        cr.$dispose();
    }

    _buildGradient() {
        this._gradient = new St.DrawingArea({ x_expand: true, y_expand: true, opacity: 0 });
        this._gradPalette = null;
        this._gradPhase = 0;
        this._gradTimer = 0;
        this._gradient.connect('repaint', area => this._drawGradient(area));
        this.add_child(this._gradient);
    }

    _setPalette(palette) {

        const lift = c => ({
            r: Math.min(255, c.r + 30), g: Math.min(255, c.g + 30), b: Math.min(255, c.b + 30),
        });
        this._gradPalette = {
            base: palette.base,
            colors: palette.colors.map(lift),
        };
        this._gradient.queue_repaint();
    }

    _drawGradient(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const pal = this._gradPalette;
        if (!pal || !this._settings.get_boolean('enable-gradient') || w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }

        const rt = Math.min(this._rTop, w / 2, h / 2);
        const rb = Math.min(this._rBottom, w / 2, h / 2);
        cr.newSubPath();
        cr.arc(rt, rt, rt, Math.PI, 1.5 * Math.PI);
        cr.arc(w - rt, rt, rt, 1.5 * Math.PI, 2 * Math.PI);
        cr.arc(w - rb, h - rb, rb, 0, 0.5 * Math.PI);
        cr.arc(rb, h - rb, rb, 0.5 * Math.PI, Math.PI);
        cr.closePath();
        cr.clip();

        const [br, bg, bb, ba] = this._fillNow();
        cr.setSourceRGBA(br, bg, bb, ba);
        cr.paint();

        const t = this._gradPhase;
        const cols = pal.colors;
        for (let i = 0; i < cols.length; i++) {
            const c = cols[i];
            const cx = w * (0.5
                + 0.30 * Math.sin(t * 0.50 + i * 1.7)
                + 0.12 * Math.sin(t * 0.23 + i * 3.1));
            const cy = h * (0.14
                + 0.10 * Math.cos(t * 0.41 + i * 2.2)
                + 0.05 * Math.sin(t * 0.29 + i * 1.3));
            const rad = Math.max(w, h) * (0.30 + 0.07 * Math.sin(t * 0.37 + i));
            const g = new cairo.RadialGradient(cx, cy, 0, cx, cy, rad);
            g.addColorStopRGBA(0, c.r / 255, c.g / 255, c.b / 255, 0.6);
            g.addColorStopRGBA(1, c.r / 255, c.g / 255, c.b / 255, 0);
            cr.setSource(g);
            cr.paint();
        }

        const fade = new cairo.LinearGradient(0, 0, 0, h);
        fade.addColorStopRGBA(0.00, br, bg, bb, 0);
        fade.addColorStopRGBA(0.40, br, bg, bb, 0.45 * ba);
        fade.addColorStopRGBA(0.62, br, bg, bb, ba);
        fade.addColorStopRGBA(1.00, br, bg, bb, ba);
        cr.setSource(fade);
        cr.paint();
        cr.$dispose();
    }

    _startGradient() {
        if (this._gradTimer || !this._settings.get_boolean('enable-gradient')) return;
        this._gradTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            this._gradPhase += 0.010;
            this._gradient.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopGradient() {
        if (this._gradTimer) { GLib.Source.remove(this._gradTimer); this._gradTimer = 0; }
    }

    _buildClosedLayer() {
        this._closedLayer = new St.BoxLayout({
            style_class: 'orbit-closed',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._closedDot = new St.Widget({
            style_class: 'orbit-closed-dot',
            width: 10, height: 10, visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._closedDot.translation_y = -2;
        this._closedLayer.add_child(this._closedDot);

        this._closedLayer.add_child(new St.Widget({ x_expand: true }));
        this._closedTime = null;
        this._updateDateTime();

        this._vis = new OrbitVisualizer(this._settings);
        this._closedLayer.add_child(this._vis);

        // Live timer / stopwatch label — shown on pill while timer runs
        this._timerPillLabel = new St.Label({
            style_class: 'orbit-timer-pill',
            text: '0:00',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._closedLayer.add_child(this._timerPillLabel);

        // Privacy indicator dots — right side of the pill (like iOS orange/green dots)
        this._privDotBox = new St.BoxLayout({
            style_class: 'orbit-priv-dots',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._privMicDot = new St.Widget({ style_class: 'orbit-priv-dot orbit-priv-mic', width: 8, height: 8 });
        this._privCamDot = new St.Widget({ style_class: 'orbit-priv-dot orbit-priv-cam', width: 8, height: 8 });
        this._privMicDot.visible = false;
        this._privCamDot.visible = false;
        this._privDotBox.add_child(this._privMicDot);
        this._privDotBox.add_child(this._privCamDot);
        this._closedLayer.add_child(this._privDotBox);

        this.add_child(this._closedLayer);

        this._buildLyricsLayer();
    }

    _buildLyricsLayer() {
        this._lyricsLayer = new St.BoxLayout({
            style_class: 'orbit-lyr', opacity: 0, reactive: false,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER,
        });

        this._lyricsArt = new St.Bin({
            style_class: 'orbit-lyr-art', width: 22, height: 22, visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._lyricsLayer.add_child(this._lyricsArt);

        this._lyricsWidget = new OrbitLyricsWidget(timeMs => this._media.seekAbsolute(timeMs * 1000));
        this._lyricsWidget.setFontSize(11);
        this._lyricsWidget.setHorizontal(true);
        this._lyricsWidget.setTextColor(255, 255, 255);
        this._lyricsLayer.add_child(this._lyricsWidget);

        this._lyricsVis = new OrbitVisualizer(this._settings);
        this._lyricsVis.y_expand = false;
        this._lyricsVis.y_align = Clutter.ActorAlign.CENTER;
        this._lyricsVis.set_height(20);
        this._lyricsLayer.add_child(this._lyricsVis);

        this.add_child(this._lyricsLayer);
    }

    _buildOpenLayer() {

        this._openLayer = new St.BoxLayout({
            style_class: 'orbit-open',
            vertical: true,
            reactive: false,
            opacity: 0,
            x_expand: true, y_expand: true,
        });
        this._openLayer.add_child(this._buildHeader());

        const body = new St.BoxLayout({
            style_class: 'orbit-body', vertical: false,
            x_expand: true, y_expand: true,
        });
        this._bodyMedia = body;

        this._openArt = new St.Bin({
            style_class: 'orbit-art-open',
            width: ART_OPEN, height: ART_OPEN,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(this._openArt);

        const right = new St.BoxLayout({
            vertical: true, x_expand: true,
            style_class: 'orbit-meta',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({ style_class: 'orbit-title', text: '' });
        this._artist = new St.Label({ style_class: 'orbit-artist', text: '' });
        this._title.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._artist.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        right.add_child(this._title);
        right.add_child(this._artist);

        this._scrubber = new St.BoxLayout({
            style_class: 'orbit-scrub', x_expand: true, reactive: true,
        });
        this._scrubFill = new St.Widget({ style_class: 'orbit-scrub-fill', y_expand: true });
        this._scrubber.add_child(this._scrubFill);
        this._scrubber.add_child(new St.Widget({ x_expand: true }));
        this._scrubber.connect('button-press-event', (a, ev) => this._onScrub(a, ev));
        right.add_child(this._scrubber);

        const times = new St.BoxLayout({ style_class: 'orbit-times' });
        this._posLabel = new St.Label({ style_class: 'orbit-time', text: '0:00' });
        this._lenLabel = new St.Label({ style_class: 'orbit-time', text: '0:00' });
        times.add_child(this._posLabel);
        times.add_child(new St.Widget({ x_expand: true }));
        times.add_child(this._lenLabel);
        right.add_child(times);

        const controls = new St.BoxLayout({
            style_class: 'orbit-controls', x_align: Clutter.ActorAlign.CENTER,
        });

        this._lyricsBtn = this._iconButton('media-view-subtitles-symbolic',
            () => this._toggleLyricsMode());
        this._lyricsBtn.add_style_class_name('orbit-lyr-btn');
        this._lyricsBtn.visible = this._settings.get_boolean('enable-lyrics');
        this._prevBtn = this._iconButton('media-skip-backward-symbolic',
            () => { this._slideIcon(this._prevBtn, -1); this._media.previous(); });
        this._playBtn = this._iconButton('media-playback-start-symbolic', () => this._media.playPause());
        this._nextBtn = this._iconButton('media-skip-forward-symbolic',
            () => { this._slideIcon(this._nextBtn, 1); this._media.next(); });
        controls.add_child(this._lyricsBtn);
        controls.add_child(this._prevBtn);
        controls.add_child(this._playBtn);
        controls.add_child(this._nextBtn);
        right.add_child(controls);
        body.add_child(right);

        this._lyricsSettingId = this._settings.connect('changed::enable-lyrics', () => {
            const on = this._settings.get_boolean('enable-lyrics');
            this._lyricsBtn.visible = on;
            if (!on) { this._lyricsMode = false; this._refreshClosedSize(); this._refreshLyricsTimer(); }
            this._updateLyricsBtn();
        });
        this._updateLyricsBtn();

        this._calBox = new St.Bin({
            style_class: 'orbit-cal-wrap',
            y_align: Clutter.ActorAlign.FILL,
        });
        body.add_child(this._calBox);
        this._openLayer.add_child(body);

        this._bodyNotif = new St.BoxLayout({
            style_class: 'orbit-notif-body', vertical: true,
            x_expand: true, y_expand: true, visible: false,
        });
        const nHead = new St.BoxLayout({ style_class: 'orbit-notif-head' });
        nHead.add_child(new St.Label({ style_class: 'orbit-notif-title', text: 'Notifications', x_expand: true }));
        const clearBtn = new St.Button({ style_class: 'orbit-notif-clear', label: 'Clear' });
        this._addPress(clearBtn);
        clearBtn.connect('clicked', () => this._notifications.clear());
        nHead.add_child(clearBtn);
        this._bodyNotif.add_child(nHead);

        this._notifScroll = new St.ScrollView({
            style_class: 'orbit-notif-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._notifList = new St.BoxLayout({ style_class: 'orbit-notif-list', vertical: true, x_expand: true });
        this._notifScroll.set_child(this._notifList);
        this._bodyNotif.add_child(this._notifScroll);
        this._openLayer.add_child(this._bodyNotif);

        this._buildShelfBody();
        this._buildTimerBody();

        this.add_child(this._openLayer);
    }

    _buildShelfBody() {

        this._bodyShelf = new St.BoxLayout({
            style_class: 'orbit-shelf-body', vertical: true,
            x_expand: true, y_expand: true, visible: false,
            reactive: true, can_focus: true,
        });

        const head = new St.BoxLayout({ style_class: 'orbit-shelf-head' });
        head.add_child(new St.Label({ style_class: 'orbit-shelf-title', text: 'Shelf', x_expand: true }));
        this._shelfHint = new St.Label({ style_class: 'orbit-shelf-hint', text: 'paste with Ctrl+V' });
        head.add_child(this._shelfHint);
        const clear = new St.Button({ style_class: 'orbit-notif-clear', label: 'Clear' });
        this._addPress(clear);
        clear.connect('clicked', () => this._shelf.clear());
        head.add_child(clear);
        this._bodyShelf.add_child(head);

        this._shelfScroll = new St.ScrollView({
            style_class: 'orbit-shelf-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
        });
        this._shelfStrip = new St.BoxLayout({
            style_class: 'orbit-shelf-strip', vertical: false, y_align: Clutter.ActorAlign.CENTER });
        this._shelfScroll.set_child(this._shelfStrip);
        this._bodyShelf.add_child(this._shelfScroll);

        this._bodyShelf.connect('key-press-event', (_a, ev) => this._onShelfKey(ev));
        this._openLayer.add_child(this._bodyShelf);
    }

    _buildTimerBody() {
        this._bodyTimer = new St.BoxLayout({
            style_class: 'orbit-timer-body',
            vertical: true,
            x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        // Big display (shows running time)
        this._timerDisplay = new St.Label({
            style_class: 'orbit-timer-display',
            text: '0:00',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._bodyTimer.add_child(this._timerDisplay);

        // Mode row: Stopwatch / Timer
        const modeRow = new St.BoxLayout({
            style_class: 'orbit-timer-modes',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._swBtn = new St.Button({ style_class: 'orbit-timer-mode-btn active', label: 'Stopwatch' });
        this._tmBtn = new St.Button({ style_class: 'orbit-timer-mode-btn', label: 'Timer' });
        this._addPress(this._swBtn);
        this._addPress(this._tmBtn);
        this._swBtn.connect('clicked', () => this._setTimerMode('stopwatch'));
        this._tmBtn.connect('clicked', () => this._setTimerMode('countdown'));
        modeRow.add_child(this._swBtn);
        modeRow.add_child(this._tmBtn);
        this._bodyTimer.add_child(modeRow);

        // Duration adjuster (only for countdown mode)
        this._timerAdjRow = new St.BoxLayout({
            style_class: 'orbit-timer-adj',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        const minDown = this._timerAdjBtn('list-remove-symbolic', () => this._nudgeTimer(-60));
        this._timerMinsLabel = new St.Label({ style_class: 'orbit-timer-adj-val', text: '5 min' });
        const minUp   = this._timerAdjBtn('list-add-symbolic',    () => this._nudgeTimer(+60));
        const secDown = this._timerAdjBtn('list-remove-symbolic', () => this._nudgeTimer(-5));
        this._timerSecsLabel = new St.Label({ style_class: 'orbit-timer-adj-val', text: '0 sec' });
        const secUp   = this._timerAdjBtn('list-add-symbolic',    () => this._nudgeTimer(+5));
        this._timerAdjRow.add_child(minDown);
        this._timerAdjRow.add_child(this._timerMinsLabel);
        this._timerAdjRow.add_child(minUp);
        this._timerAdjRow.add_child(new St.Widget({ width: 12 }));
        this._timerAdjRow.add_child(secDown);
        this._timerAdjRow.add_child(this._timerSecsLabel);
        this._timerAdjRow.add_child(secUp);
        this._bodyTimer.add_child(this._timerAdjRow);

        // Control buttons
        const ctrlRow = new St.BoxLayout({
            style_class: 'orbit-timer-ctrl',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._timerStartBtn = new St.Button({ style_class: 'orbit-timer-start-btn', label: 'Start' });
        this._timerResetBtn = new St.Button({ style_class: 'orbit-timer-reset-btn', label: 'Reset' });
        this._addPress(this._timerStartBtn);
        this._addPress(this._timerResetBtn);
        this._timerStartBtn.connect('clicked', () => this._onTimerStartStop());
        this._timerResetBtn.connect('clicked', () => this._onTimerReset());
        ctrlRow.add_child(this._timerStartBtn);
        ctrlRow.add_child(this._timerResetBtn);
        this._bodyTimer.add_child(ctrlRow);

        // Internal state
        this._timerMode    = 'stopwatch';   // 'stopwatch' | 'countdown'
        this._timerRunning = false;
        this._timerElapsed = 0;             // ms (stopwatch) or ms remaining (countdown)
        this._timerTarget  = 5 * 60 * 1000; // default 5 min for countdown
        this._timerTickId  = 0;
        this._timerLastTs  = 0;

        this._openLayer.add_child(this._bodyTimer);
    }

    _timerAdjBtn(icon, cb) {
        const b = new St.Button({ style_class: 'orbit-timer-adj-btn' });
        b.set_child(new St.Icon({ icon_name: icon, icon_size: 14 }));
        this._addPress(b);
        b.connect('clicked', cb);
        return b;
    }

    _setTimerMode(mode) {
        if (this._timerRunning) this._onTimerReset();
        this._timerMode = mode;
        const sw = mode === 'stopwatch';
        this._swBtn.style_class = `orbit-timer-mode-btn${sw ? ' active' : ''}`;
        this._tmBtn.style_class = `orbit-timer-mode-btn${sw ? '' : ' active'}`;
        this._timerAdjRow.visible = !sw;
        this._timerDisplay.text = sw ? '0:00' : this._formatTimer(this._timerTarget);
        this._timerElapsed = 0;
    }

    _nudgeTimer(deltaSec) {
        if (this._timerRunning) return;
        this._timerTarget = Math.max(5000, this._timerTarget + deltaSec * 1000);
        const total = Math.round(this._timerTarget / 1000);
        const m = Math.floor(total / 60), s = total % 60;
        this._timerMinsLabel.text = `${m} min`;
        this._timerSecsLabel.text = `${s} sec`;
        this._timerDisplay.text   = this._formatTimer(this._timerTarget);
    }

    _onTimerStartStop() {
        if (!this._timerRunning) {
            // Start
            this._timerRunning = true;
            this._timerLastTs  = GLib.get_monotonic_time();
            this._timerStartBtn.label = 'Pause';
            this._timerTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._tickTimer();
                return this._timerRunning ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            });
            // Show live label on closed pill
            this._timerPillLabel.visible = true;
        } else {
            // Pause
            this._timerRunning = false;
            if (this._timerTickId) { GLib.Source.remove(this._timerTickId); this._timerTickId = 0; }
            this._timerStartBtn.label = 'Resume';
        }
    }

    _onTimerReset() {
        this._timerRunning = false;
        if (this._timerTickId) { GLib.Source.remove(this._timerTickId); this._timerTickId = 0; }
        this._timerElapsed = 0;
        this._timerStartBtn.label = 'Start';
        const dispMs = this._timerMode === 'stopwatch' ? 0 : this._timerTarget;
        this._timerDisplay.text = this._formatTimer(dispMs);
        if (this._timerPillLabel) this._timerPillLabel.visible = false;
    }

    _tickTimer() {
        const now = GLib.get_monotonic_time();
        const delta = Math.round((now - this._timerLastTs) / 1000); // ms
        this._timerLastTs = now;

        if (this._timerMode === 'stopwatch') {
            this._timerElapsed += delta;
            const t = this._formatTimer(this._timerElapsed);
            if (this._timerDisplay) this._timerDisplay.text = t;
            if (this._timerPillLabel) this._timerPillLabel.text = t;
        } else {
            this._timerElapsed += delta;
            const remaining = Math.max(0, this._timerTarget - this._timerElapsed);
            const t = this._formatTimer(remaining);
            if (this._timerDisplay) this._timerDisplay.text = t;
            if (this._timerPillLabel) this._timerPillLabel.text = t;
            if (remaining === 0) {
                this._timerRunning = false;
                this._timerStartBtn.label = 'Start';
                this._timerElapsed = 0;
                if (this._timerPillLabel) this._timerPillLabel.visible = false;
                // Brief HUD
                this.showHud('timer-done', null, 'Timer Done');
                return;
            }
        }
    }

    _formatTimer(ms) {
        const total = Math.round(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const ss = String(s).padStart(2, '0');
        return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${ss}` : `${m}:${ss}`;
    }

    _renderShelf() {
        if (!this._shelfStrip) return;
        this._shelfStrip.destroy_all_children();
        const items = this._shelf.items();
        if (items.length === 0) {
            this._shelfStrip.add_child(new St.Label({
                style_class: 'orbit-shelf-empty',
                text: 'Paste files here with Ctrl+V',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }
        for (const it of items) this._shelfStrip.add_child(this._shelfCard(it));
    }

    _shelfCard(it) {
        const card = new St.BoxLayout({ style_class: 'orbit-shelf-card', vertical: true });

        const thumb = new St.Bin({
            style_class: 'orbit-shelf-thumb', reactive: true, track_hover: true, can_focus: true,
            width: 72, height: 72, x_align: Clutter.ActorAlign.CENTER });
        if (it.isImage) {
            thumb.set_style(`background-image: url("${it.uri}"); background-size: cover;`);
        } else {
            const icon = new St.Icon({ icon_size: 44 });
            try { icon.set_gicon(Gio.content_type_get_icon(it.contentType)); }
            catch (e) { icon.icon_name = 'text-x-generic-symbolic'; }
            thumb.set_child(icon);
        }
        this._addPress(thumb);
        const name = new St.Label({ style_class: 'orbit-shelf-name', text: it.name });
        name.clutter_text.set_ellipsize(Pango.EllipsizeMode.MIDDLE);

        thumb.connect('button-press-event', () => { this._pasteCard(it, name); return Clutter.EVENT_STOP; });
        card.add_child(thumb);
        card.add_child(name);

        const actions = new St.BoxLayout({ style_class: 'orbit-shelf-actions', x_align: Clutter.ActorAlign.CENTER });
        const copy = this._cardAct('edit-copy-symbolic', () => this._copyCard(it, name));
        const reveal = this._cardAct('folder-open-symbolic', () => this._revealCard(it));
        const del = this._cardAct('window-close-symbolic', () => this._shelf.remove(it.id));
        actions.add_child(copy);
        actions.add_child(reveal);
        actions.add_child(del);
        card.add_child(actions);
        return card;
    }

    _cardAct(iconName, onClick) {
        const btn = new St.Button({ style_class: 'orbit-shelf-act' });
        btn.set_child(new St.Icon({ icon_name: iconName, icon_size: 13 }));
        this._addPress(btn);
        btn.connect('clicked', onClick);
        return btn;
    }

    _onShelfKey(ev) {
        const sym = ev.get_key_symbol();
        const ctrl = (ev.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (sym === Clutter.KEY_v || sym === Clutter.KEY_V)) {
            this._pasteClipboard();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _putOnClipboard(it) {
        const clip = St.Clipboard.get_default();
        if (it.isImage) {
            try {
                const [, data] = GLib.file_get_contents(it.path);
                clip.set_content(St.ClipboardType.CLIPBOARD, it.contentType, new GLib.Bytes(data));
                return;
            } catch (e) {}
        }
        clip.set_content(St.ClipboardType.CLIPBOARD, 'text/uri-list',
            new GLib.Bytes(new TextEncoder().encode(`${it.uri}\r\n`)));
    }

    _copyCard(it, label) {
        this._putOnClipboard(it);
        this._flashLabel(label, 'Copied ✓');
    }

    _pasteCard(it, label) {
        this._putOnClipboard(it);
        const target = this._pasteTarget;
        try { global.stage.set_key_focus(null); } catch (e) {}
        if (target) { try { target.activate(global.get_current_time()); } catch (e) {} }

        this._addTimeout(130, () => this._sendPaste());
        this._flashLabel(label, 'Pasted ✓');
    }

    _sendPaste() {
        try {
            if (!this._vkbd) {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._vkbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            const t = global.get_current_time();
            const K = Clutter.KeyState;
            this._vkbd.notify_keyval(t, Clutter.KEY_Control_L, K.PRESSED);
            this._vkbd.notify_keyval(t, Clutter.KEY_v, K.PRESSED);
            this._vkbd.notify_keyval(t, Clutter.KEY_v, K.RELEASED);
            this._vkbd.notify_keyval(t, Clutter.KEY_Control_L, K.RELEASED);
        } catch (e) {}
    }

    _flashLabel(label, msg) {
        if (!label) return;
        const orig = label.text;
        label.text = msg;
        label.add_style_class_name('orbit-shelf-copied');
        this._addTimeout(1100, () => {
            try {
                if (label.get_stage()) {
                    label.text = orig;
                    label.remove_style_class_name('orbit-shelf-copied');
                }
            } catch (e) {}
        });
    }

    _revealCard(it) {
        try {
            Gio.DBus.session.call(
                'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
                'org.freedesktop.FileManager1', 'ShowItems',
                new GLib.Variant('(ass)', [[it.uri], '']),
                null, Gio.DBusCallFlags.NONE, -1, null,
                (src, res) => {
                    try { src.call_finish(res); }
                    catch (e) { this._xdgOpen(GLib.path_get_dirname(it.path)); }
                });
        } catch (e) { this._xdgOpen(GLib.path_get_dirname(it.path)); }
    }

    _xdgOpen(target) {
        try { Gio.Subprocess.new(['xdg-open', target], Gio.SubprocessFlags.NONE); } catch (e) {}
    }

    _pasteClipboard() {
        const clip = St.Clipboard.get_default();
        const mimes = clip.get_mimetypes(St.ClipboardType.CLIPBOARD) || [];
        if (mimes.includes('text/uri-list')) {
            clip.get_content(St.ClipboardType.CLIPBOARD, 'text/uri-list', (_c, bytes) => {
                const data = bytes && bytes.get_data();
                if (!data || !data.length) return;
                this._shelf.addUris(this._parseUriList(new TextDecoder().decode(data)));
            });
            return;
        }
        const img = mimes.find(m => m.startsWith('image/'));
        if (img) {
            clip.get_content(St.ClipboardType.CLIPBOARD, img, (_c, bytes) => {
                const data = bytes && bytes.get_data();
                if (!data || !data.length) return;
                this._shelf.addImageBytes(bytes, img.split('/')[1] || 'png');
            });
        }
    }

    _parseUriList(text) {
        return text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    }

    _updateShelfBadge() {
        if (!this._shelfTab) return;
        if (this._shelf.count() > 0) this._shelfTab.add_style_class_name('has-items');
        else this._shelfTab.remove_style_class_name('has-items');
    }

    showView(view) {
        this._view = view;
        this._bodyMedia.visible = view === 'media';
        this._bodyNotif.visible = view === 'notifs';
        this._bodyShelf.visible = view === 'shelf';
        if (this._bodyTimer) this._bodyTimer.visible = view === 'timer';
        for (const t of [this._homeTab, this._shelfTab, this._bellTab, this._timerTab])
            t.remove_style_class_name('active');
        const tab = view === 'media'  ? this._homeTab
            : view === 'shelf'  ? this._shelfTab
            : view === 'timer'  ? this._timerTab
            : this._bellTab;
        tab.add_style_class_name('active');
        if (view === 'notifs') { this._unread = false; this._updateClosedDot(); this._renderNotifList(); }
        if (view === 'shelf') {
            this._renderShelf();

            try { this._pasteTarget = global.display.focus_window; } catch (e) { this._pasteTarget = null; }

            this._addTimeout(0, () => {
                if (this._bodyShelf && this._bodyShelf.visible) this._bodyShelf.grab_key_focus();
            });
        }
        if (!this._open) this.open();
    }

    _renderNotifList() {
        if (!this._notifList) return;
        this._notifList.destroy_all_children();
        const groups = this._notifications.getGroups();
        if (groups.length === 0) {
            this._notifList.add_child(new St.Label({
                style_class: 'orbit-notif-empty', text: 'No notifications' }));
            return;
        }
        for (const g of groups) this._notifList.add_child(this._notifGroup(g));
    }

    _notifGroup(g) {
        const expanded = this._expandedGroups.has(g.key) || g.items.length === 1;

        const wrap = new St.BoxLayout({ style_class: 'orbit-ng', vertical: true, x_expand: true });

        const head = new St.BoxLayout({ style_class: 'orbit-ng-head', x_expand: true });
        const icon = new St.Icon({ style_class: 'orbit-ng-icon', icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        if (g.gicon) icon.set_gicon(g.gicon); else icon.icon_name = 'dialog-information-symbolic';
        head.add_child(icon);
        head.add_child(new St.Label({
            style_class: 'orbit-ng-name', text: g.appName, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER }));

        if (g.items.length > 1) {
            head.add_child(new St.Label({
                style_class: 'orbit-ng-count', text: `${g.items.length}`,
                y_align: Clutter.ActorAlign.CENTER }));
            const chev = new St.Button({ style_class: 'orbit-ng-btn' });
            chev.set_child(new St.Icon({
                icon_name: expanded ? 'pan-up-symbolic' : 'pan-down-symbolic', icon_size: 14 }));
            this._addPress(chev);
            chev.connect('clicked', () => {
                if (this._expandedGroups.has(g.key)) this._expandedGroups.delete(g.key);
                else this._expandedGroups.add(g.key);
                this._renderNotifList();
            });
            head.add_child(chev);
        }

        const close = new St.Button({ style_class: 'orbit-ng-btn' });
        close.set_child(new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }));
        this._addPress(close);
        close.connect('clicked', () => this._notifications.clearGroup(g.key));
        head.add_child(close);
        wrap.add_child(head);

        const shown = expanded ? g.items : [g.items[0]];
        for (const item of shown) wrap.add_child(this._notifItemRow(item));
        return wrap;
    }

    _notifItemRow(item) {
        const full = this._expandedItems.has(item.id);
        const row = new St.Button({ style_class: 'orbit-notif-row', x_expand: true, can_focus: true });
        const box = new St.BoxLayout({ x_expand: true });

        const icon = new St.Icon({ style_class: 'orbit-notif-icon', icon_size: 24, y_align: Clutter.ActorAlign.START });
        if (item.gicon) icon.set_gicon(item.gicon); else icon.icon_name = 'dialog-information-symbolic';
        box.add_child(icon);

        const txt = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'orbit-notif-txt' });
        const t = new St.Label({ style_class: 'orbit-notif-row-title', text: item.title || '' });
        if (full) t.clutter_text.set_line_wrap(true);
        else t.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        txt.add_child(t);
        if (item.body) {
            const b = new St.Label({ style_class: 'orbit-notif-row-body', text: item.body });
            if (full) b.clutter_text.set_line_wrap(true);
            else b.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            txt.add_child(b);
        }
        box.add_child(txt);

        const time = new St.Label({
            style_class: 'orbit-notif-time',
            text: item.time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
            y_align: Clutter.ActorAlign.START,
        });
        box.add_child(time);

        row.set_child(box);
        row.connect('clicked', () => {
            if (this._expandedItems.has(item.id)) this._expandedItems.delete(item.id);
            else this._expandedItems.add(item.id);
            this._renderNotifList();
        });
        return row;
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'orbit-header',
            y_align: Clutter.ActorAlign.CENTER,
            vertical: false,
        });

        const tabs = new St.BoxLayout({
            style_class: 'orbit-tabs',
            y_align: Clutter.ActorAlign.CENTER,
            vertical: false,
        });
        this._homeTab = this._tabButton('go-home-symbolic');
        this._homeTab.add_style_class_name('active');
        this._homeTab.connect('clicked', () => this.showView('media'));
        this._shelfTab = this._tabButton('folder-symbolic');
        this._shelfTab.connect('clicked', () => this.showView('shelf'));
        this._shelfTab.visible = this._settings.get_boolean('enable-shelf');
        this._bellTab = this._tabButton('preferences-system-notifications-symbolic');
        this._bellTab.connect('clicked', () => this.showView('notifs'));
        this._timerTab = this._tabButton('timer-symbolic');
        this._timerTab.connect('clicked', () => this.showView('timer'));
        tabs.add_child(this._homeTab);
        tabs.add_child(this._shelfTab);
        tabs.add_child(this._bellTab);
        tabs.add_child(this._timerTab);
        header.add_child(tabs);

        this._shelfSettingId = this._settings.connect('changed::enable-shelf', () => {
            this._shelfTab.visible = this._settings.get_boolean('enable-shelf');
        });
        this._updateShelfBadge();

        header.add_child(new St.Widget({ x_expand: true }));
        this._headerDate = new St.Label({
            style_class: 'orbit-header-date', y_align: Clutter.ActorAlign.CENTER });
        header.add_child(this._headerDate);
        header.add_child(new St.Widget({ x_expand: true }));

        const sys = new St.BoxLayout({
            style_class: 'orbit-sys',
            y_align: Clutter.ActorAlign.CENTER,
            vertical: false,
        });
        const gear = new St.Button({
            style_class: 'orbit-sys-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        gear.set_child(new St.Icon({
            icon_name: 'emblem-system-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._addPress(gear);
        gear.connect('clicked', () => this._openPrefs());
        sys.add_child(gear);

        const battBox = new St.BoxLayout({
            style_class: 'orbit-batt-box',
            y_align: Clutter.ActorAlign.CENTER,
            vertical: false,
        });
        this._battLabel = new St.Label({
            style_class: 'orbit-batt-pct',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._battIcon = new St.Icon({
            style_class: 'orbit-batt-icon',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        battBox.add_child(this._battLabel);
        battBox.add_child(this._battIcon);
        sys.add_child(battBox);

        header.add_child(sys);

        return header;
    }

    _tabButton(iconName) {
        const btn = new St.Button({ style_class: 'orbit-tab', can_focus: true });
        btn.set_child(new St.Icon({ icon_name: iconName, icon_size: 16 }));
        this._addPress(btn);
        return btn;
    }

    _iconButton(iconName, onClick) {
        const btn = new St.Button({ style_class: 'orbit-ctrl', can_focus: true });
        btn.set_child(new St.Icon({ icon_name: iconName, icon_size: 20 }));
        btn.connect('clicked', onClick);
        this._addPress(btn);
        return btn;
    }

    _addPress(btn) {
        btn.set_pivot_point(0.5, 0.5);
        btn.connect('button-press-event', () => {
            btn.remove_all_transitions();
            btn.ease({ scale_x: 0.80, scale_y: 0.80, duration: 90,
                       mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            return Clutter.EVENT_PROPAGATE;
        });
        const back = () => {
            btn.remove_all_transitions();
            btn.ease({ scale_x: 1, scale_y: 1, duration: 380,
                       mode: Clutter.AnimationMode.EASE_OUT_BACK });
        };
        btn.connect('button-release-event', () => { back(); return Clutter.EVENT_PROPAGATE; });
        btn.connect('leave-event', () => { back(); return Clutter.EVENT_PROPAGATE; });
    }

    _swapIcon(iconActor, name) {
        if (!iconActor || iconActor.icon_name === name) return;
        iconActor.remove_all_transitions();
        iconActor.set_pivot_point(0.5, 0.5);
        iconActor.opacity = 255;
        iconActor.ease({
            scale_x: 0.80, scale_y: 0.80, duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                iconActor.icon_name = name;
                iconActor.ease({ scale_x: 1, scale_y: 1, duration: 300,
                                 mode: Clutter.AnimationMode.EASE_OUT_BACK });
            },
        });
    }

    _slideIcon(btn, dir) {
        const ic = btn.child;
        if (!ic) return;
        ic.remove_all_transitions();
        ic.set_pivot_point(0.5, 0.5);
        ic.opacity = 255;
        ic.ease({
            translation_x: dir * 9, duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                ic.ease({ translation_x: 0, duration: 340,
                          mode: Clutter.AnimationMode.EASE_OUT_BACK });
            },
        });
    }

    _renderCalendar() {
        if (!this._calBox) return;
        this._calBox.set_child(this._calendar.render());
    }

    _updateBattery() {
        if (!this._battLabel || !this._battIcon) return;
        const dev = this._upower ? this._upower.get_display_device() : null;
        const present = dev && dev.is_present &&
            dev.kind === UPowerGlib.DeviceKind.BATTERY;
        if (!present) {
            this._battLabel.text = '';
            this._battIcon.visible = false;
            this._lastChargingState = undefined;
            return;
        }
        const pct = Math.round(dev.percentage);
        const charging = dev.state === UPowerGlib.DeviceState.CHARGING ||
                         dev.state === UPowerGlib.DeviceState.FULLY_CHARGED;
        this._battLabel.text = `${pct}%`;
        const level = Math.max(0, Math.min(100, Math.round(pct / 10) * 10));
        this._battIcon.icon_name = charging
            ? `battery-level-${level}-charging-symbolic`
            : `battery-level-${level}-symbolic`;
        if (charging)
            this._battIcon.add_style_class_name('charging');
        else
            this._battIcon.remove_style_class_name('charging');
        this._battIcon.visible = true;

        // Show charger HUD when plug/unplug state changes
        if (this._lastChargingState !== undefined && this._lastChargingState !== charging) {
            const type = charging ? 'charger-in' : 'charger-out';
            const pctLabel = charging ? `Charging • ${pct}%` : `On Battery • ${pct}%`;
            this.showHud(type, null, pctLabel);
        }
        this._lastChargingState = charging;
    }

    _buildNotifLayer() {
        this._notifLayer = new St.BoxLayout({
            style_class: 'orbit-peek', reactive: false, opacity: 0,
            x_expand: true, y_expand: true,
        });
        this._peekIcon = new St.Icon({
            style_class: 'orbit-peek-icon', icon_size: 36, y_align: Clutter.ActorAlign.CENTER });
        this._notifLayer.add_child(this._peekIcon);

        const col = new St.BoxLayout({
            vertical: true, x_expand: true, style_class: 'orbit-peek-txt',
            y_align: Clutter.ActorAlign.CENTER });
        this._peekTitle = new St.Label({ style_class: 'orbit-peek-title' });
        this._peekBody = new St.Label({ style_class: 'orbit-peek-body' });
        this._peekTitle.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._peekBody.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        col.add_child(this._peekTitle);
        col.add_child(this._peekBody);
        this._notifLayer.add_child(col);

        this._peekTime = new St.Label({ style_class: 'orbit-peek-app', y_align: Clutter.ActorAlign.CENTER });
        this._notifLayer.add_child(this._peekTime);
        this.add_child(this._notifLayer);
    }

    _buildHudLayer() {
        // Outer box: icon on left, content on right
        this._hudLayer = new St.BoxLayout({
            style_class: 'orbit-hud',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0, reactive: false,
            vertical: false,
        });

        this._hudIcon = new St.Icon({
            style_class: 'orbit-hud-icon',
            icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._hudLayer.add_child(this._hudIcon);

        // Middle: label (volume/brightness/charger name) + slider track
        const mid = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'orbit-hud-mid',
        });

        this._hudLabel = new St.Label({
            style_class: 'orbit-hud-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._hudLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        mid.add_child(this._hudLabel);

        // Slider track + fill
        const track = new St.Widget({ style_class: 'orbit-hud-track', height: 4, x_expand: true });
        this._hudFill = new St.Widget({ style_class: 'orbit-hud-fill', height: 4 });
        track.add_child(this._hudFill);
        mid.add_child(track);
        this._hudTrack = track;

        this._hudLayer.add_child(mid);

        // Right: value label (e.g. "72%")
        this._hudValue = new St.Label({
            style_class: 'orbit-hud-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._hudLayer.add_child(this._hudValue);

        this.add_child(this._hudLayer);
    }

    // Public: called from extension.js when OSD fires.
    // type: 'volume' | 'brightness' | 'charger-in' | 'charger-out'
    // value: 0-1 fraction (volume/brightness), or null (charger)
    // label: optional override string
    showHud(type, value, label) {
        if (this._open) return;
        this._clearHudTimer();

        // Set icon based on type
        const iconMap = {
            'volume-high':   'audio-volume-high-symbolic',
            'volume-medium': 'audio-volume-medium-symbolic',
            'volume-low':    'audio-volume-low-symbolic',
            'volume-muted':  'audio-volume-muted-symbolic',
            'brightness':    'display-brightness-symbolic',
            'charger-in':    'battery-full-charging-symbolic',
            'charger-out':   'battery-full-symbolic',
            'microphone':    'audio-input-microphone-symbolic',
            'camera':        'camera-web-symbolic',
            'timer-done':    'alarm-symbolic',
            'bluetooth-connect':    'bluetooth-active-symbolic',
            'bluetooth-disconnect': 'bluetooth-disabled-symbolic',
        };

        // Auto-pick volume sub-type from value
        let hudType = type;
        if (type === 'volume' && value !== null) {
            if (value <= 0) hudType = 'volume-muted';
            else if (value < 0.35) hudType = 'volume-low';
            else if (value < 0.70) hudType = 'volume-medium';
            else hudType = 'volume-high';
        }

        this._hudIcon.icon_name = iconMap[hudType] || iconMap['brightness'];

        const isSlider = value !== null && value !== undefined;
        this._hudLabel.text = label || ({
            'volume-high': 'Volume', 'volume-medium': 'Volume',
            'volume-low': 'Volume', 'volume-muted': 'Volume (Muted)',
            'brightness': 'Brightness',
            'charger-in': 'Charging', 'charger-out': 'On Battery',
            'microphone': 'Microphone', 'camera': 'Camera',
            'timer-done': 'Timer Done ✓',
        }[hudType] || type);

        if (isSlider) {
            this._hudValue.text = `${Math.round(value * 100)}%`;
            this._hudTrack.visible = true;
            // Resize fill when track lays out
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                const tw = this._hudTrack.width;
                if (tw > 0) this._hudFill.set_width(Math.round(tw * value));
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._hudValue.text = '';
            this._hudTrack.visible = false;
        }

        this._hudActive = true;
        this._expMode = 'hud';
        this._peeking = false;
        this._hinting = false;
        this._animateGeom(HUD_W, this._ch, SPRINGS.peek);

        this._hudTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2200, () => {
            this._hudTimer = 0;
            if (!this.hover) this._collapseHud();
            return GLib.SOURCE_REMOVE;
        });
    }

    _collapseHud() {
        if (!this._hudActive) return;
        this._hudActive = false;
        this._expMode = 'home';
        this._animateGeom(this._cw, this._ch, SPRINGS.close);
    }

    _clearHudTimer() {
        if (this._hudTimer) { GLib.Source.remove(this._hudTimer); this._hudTimer = 0; }
    }

    // Public — called by extension.js when mic/camera state changes.
    setPrivacyState(micActive, camActive) {
        const micWas = this._privMicActive ?? false;
        const camWas = this._privCamActive ?? false;
        this._privMicActive = micActive;
        this._privCamActive = camActive;

        // Update persistent dots on the closed pill
        if (this._privMicDot) this._privMicDot.visible = micActive;
        if (this._privCamDot) this._privCamDot.visible = camActive;
        if (this._privDotBox) this._privDotBox.visible = micActive || camActive;

        // Flash a brief HUD notification when a resource is newly claimed
        if (micActive && !micWas)
            this.showHud('microphone', null, 'Microphone Active');
        if (camActive && !camWas)
            this.showHud('camera', null, 'Camera Active');
    }

    _renderPeek(item) {
        if (item.gicon) this._peekIcon.set_gicon(item.gicon);
        else this._peekIcon.icon_name = 'dialog-information-symbolic';
        this._peekTitle.text = item.title || item.appName || '';
        this._peekBody.text = item.body || '';
        this._peekBody.visible = !!item.body;
        this._peekTime.text = item.appName || '';
    }

    _showPeek(item) {
        if (!this._settings.get_boolean('enable-notifications')) return;
        if (!this._dndSettings.get_boolean('show-banners')) return;
        if (this._open) return;
        this._renderPeek(item);
        this._peekItem = item;
        this._expMode = 'notif';
        this._peeking = true;
        this._hinting = false;
        this._clearPeekTimer();
        this._animateGeom(this._notifW, Math.max(this._ch, NOTIF_H), SPRINGS.peek);
        const secs = Math.max(1, this._settings.get_int('notif-peek-seconds'));
        this._peekTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {

            if (this.hover) return GLib.SOURCE_CONTINUE;
            this._peekTimer = 0;
            this._collapsePeek();
            return GLib.SOURCE_REMOVE;
        });
    }

    _collapsePeek() {
        if (!this._peeking) return;
        this._peeking = false;
        this._animateGeom(this._cw, this._ch, SPRINGS.close, () => {
            this._expMode = 'home';
        });
    }

    _clearPeekTimer() {
        if (this._peekTimer) { GLib.Source.remove(this._peekTimer); this._peekTimer = 0; }
    }

    _openPrefs() {
        if (this._openPrefsCb) this._openPrefsCb();
    }

    _addTimeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._transientTimeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._transientTimeouts.add(id);
    }

    _applyGeom(w, h) {
        this.set_size(Math.round(w), Math.round(h));
        this._reposition();

        const span = Math.max(1, this._openW - this._cw);
        const openFrac = clamp01((w - this._cw) / span);
        this._openFrac = openFrac;

        this._rTop = lerp(RADIUS.closed.top, RADIUS.open.top, openFrac);
        this._rBottom = lerp(RADIUS.closed.bottom, RADIUS.open.bottom, openFrac);
        this._shape.queue_repaint();

        const home = this._expMode === 'home';
        const hud = this._expMode === 'hud';
        const fadeIn = clamp01((openFrac - 0.4) / 0.6);

        const peekSpan = Math.max(1, this._notifW - this._cw);
        const peekFrac = clamp01((w - this._cw) / peekSpan);
        const notifFade = clamp01((peekFrac - 0.25) / 0.75);

        const hudSpan = Math.max(1, HUD_W - this._cw);
        const hudFrac = clamp01((w - this._cw) / hudSpan);
        const hudFade = clamp01((hudFrac - 0.2) / 0.8);

        const expFrac = home ? openFrac : (hud ? hudFrac : peekFrac);
        this._expFrac = expFrac;
        if (this._blurFx && Blur) {
            const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            this._blurFx.corner_radius = this._rBottom * sf;
        }
        const closedOpacity = clamp01(1 - expFrac * 2.2);
        const lyr = this._lyricsActive();
        this._closedLayer.opacity = Math.round((lyr ? 0 : closedOpacity) * 255);
        if (this._lyricsLayer) {
            this._lyricsLayer.opacity = Math.round((lyr ? closedOpacity : 0) * 255);
            this._lyricsLayer.reactive = lyr && home && openFrac < 0.1;
        }
        this._settleLayer(this._openLayer, home ? fadeIn : 0);
        this._openLayer.reactive = home && openFrac > 0.9;
        if (this._notifLayer) this._settleLayer(this._notifLayer, home ? 0 : (hud ? 0 : notifFade));
        if (this._hudLayer) this._settleLayer(this._hudLayer, hud ? hudFade : 0);
        if (this._gradient) this._gradient.opacity = Math.round((home ? fadeIn : 0) * 255);
    }

    _settleLayer(layer, f) {
        layer.opacity = Math.round(f * 255);
        layer.set_pivot_point(0.5, 0.32);
        const s = lerp(0.955, 1, f);
        layer.set_scale(s, s);
        layer.translation_y = lerp(12, 0, f);
    }

    _reposition() {
        if (!this._monitor) return;
        const w = this.width;
        const x = this._monitor.x + Math.round((this._monitor.width - w) / 2);
        this.set_position(x, this._monitor.y);
    }

    _animateGeom(toW, toH, spring, onDone) {
        const fromW = this.width, fromH = this.height;
        if (Math.abs(toW - fromW) < 1 && Math.abs(toH - fromH) < 1) {
            this._applyGeom(toW, toH);
            if (onDone) onDone();
            return;
        }
        this._anim.run(spring,
            s => this._applyGeom(lerp(fromW, toW, s), lerp(fromH, toH, s)),
            () => { this._applyGeom(toW, toH); if (onDone) onDone(); });
    }

    open() {

        this._clearPeekTimer();
        this._peeking = false;
        this._expMode = 'home';
        this._clearOpenTimer();
        this._hinting = false;
        if (this._open && this.width >= this._openW - 1) return;
        this._open = true;
        this._clearCloseTimer();
        this._calendar.resetSelected();
        this._renderCalendar();
        this._updateBattery();
        this._startGradient();
        this._animateGeom(this._openW, this._openH, SPRINGS.open);
        this._refreshLyricsTimer();
    }

    close() {
        if (!this._open) return;
        this._open = false;
        this._stopGradient();
        this._refreshLyricsTimer();

        this._animateGeom(this._cw, this._ch, SPRINGS.close, () => {

            this._expandedItems.clear();
            this._expandedGroups.clear();
            if (this._view !== 'media') {
                this._view = 'media';
                this._bodyMedia.visible = true;
                this._bodyNotif.visible = false;
                this._bodyShelf.visible = false;
                if (this._bodyTimer) this._bodyTimer.visible = false;
                this._homeTab.add_style_class_name('active');
                this._shelfTab.remove_style_class_name('active');
                this._bellTab.remove_style_class_name('active');
                if (this._timerTab) this._timerTab.remove_style_class_name('active');
            }
        });
    }

    _onHover() {
        if (!this._settings.get_boolean('open-on-hover')) return;
        if (this.hover) {
            this._clearCloseTimer();
            this._scheduleOpen();
        } else {
            this._clearOpenTimer();
            this._retractHint();
            this._scheduleClose();
        }
    }

    _scheduleOpen() {
        if (this._openTimer) return;
        const delay = this._settings.get_int('hover-open-delay-ms');
        const midClose = !this._peeking && this._openFrac > 0.1;
        if (delay <= 0 || this._open || midClose) {
            this._openNow();
            return;
        }
        this._showHint();
        this._openTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._openTimer = 0;
            if (this.hover) this._openNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _openNow() {
        if (this._peeking) this._openToPeek();
        else this.open();
    }

    _clearOpenTimer() {
        if (this._openTimer) { GLib.Source.remove(this._openTimer); this._openTimer = 0; }
    }

    _showHint() {
        if (!this._settings.get_boolean('hover-hint')) return;
        if (this._open || this._peeking) return;
        this._hinting = true;
        this._animateGeom(this._cw + HINT_GROW_W, this._ch + HINT_GROW_H, SPRINGS.hint);
    }

    _retractHint() {
        if (!this._hinting) return;
        this._hinting = false;
        if (this._open || this._peeking) return;
        this._animateGeom(this._cw, this._ch, SPRINGS.hint);
    }

    _onClick() {
        if (this._open) return Clutter.EVENT_PROPAGATE;
        this._clearOpenTimer();
        this._openNow();
        return Clutter.EVENT_STOP;
    }

    _openToPeek() {
        const item = this._peekItem;
        this._clearPeekTimer();
        this._peeking = false;
        if (item) {
            this._expandedGroups.add(item.appName || 'Notifications');
            this._expandedItems.add(item.id);
        }
        this.showView('notifs');
    }

    _scheduleClose() {
        this._clearCloseTimer();
        const delay = Math.max(0, this._settings.get_int('hover-close-delay-ms'));
        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._closeTimer = 0;
            if (!this.hover) this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearCloseTimer() {
        if (this._closeTimer) { GLib.Source.remove(this._closeTimer); this._closeTimer = 0; }
    }

    _onScrub(actor, event) {
        const st = this._media.getState();
        if (!st.hasPlayer || st.lengthUs <= 0) return Clutter.EVENT_PROPAGATE;
        const [ex] = event.get_coords();
        const [ax] = actor.get_transformed_position();
        const frac = clamp01((ex - ax) / Math.max(1, actor.width));
        this._media.seekAbsolute(frac * st.lengthUs);

        this._scrubFill.set_width(Math.round((actor.width) * frac));
        return Clutter.EVENT_STOP;
    }

    _onMediaChanged() {
        const st = this._media.getState();
        const playing = st.hasPlayer && st.status === 'Playing';

        if (!st.hasPlayer) {
            this._title.text = '';
            this._artist.text = '';
            this._setArt(this._openArt, null);
            this._setArt(this._lyricsArt, null);
            this._gradPalette = null;
            this._vis.visible = false;
            this._vis.setPlaying(false);
            this._lyricsVis.setPlaying(false);
            this._swapIcon(this._playBtn.child, 'media-playback-start-symbolic');
            this._updateClosedDot();
            this._clearLyrics();
            return;
        }

        this._title.text = st.title || 'Unknown';
        this._artist.text = st.artist || '';
        this._swapIcon(this._playBtn.child,
            playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');
        this._lenLabel.text = this._fmt(st.lengthUs);
        this._updateScrubber(st);

        this._vis.visible = this._settings.get_boolean('show-visualizer');
        this._vis.setPlaying(playing);
        this._lyricsVis.setPlaying(playing);
        this._updateClosedDot();

        const key = `${st.title} ${st.artist} ${st.lengthUs}`;
        if (key !== this._trackKey) {
            this._trackKey = key;
            this._fetchLyrics(st);
        }
        this._refreshLyricsTimer();

        if (st.artUrl) {
            this._media.ensureArtwork(st.artUrl, meta => {
                const uri = `file://${meta.path}`;
                this._setArt(this._openArt, uri);
                this._setArt(this._lyricsArt, uri);
                this._accent = meta.palette.base;
                this._vis.setColor(this._accent);
                this._lyricsVis.setColor(this._accent);
                this._updateClosedDot();
                this._shape.queue_repaint();
                if (this._settings.get_boolean('enable-gradient')) this._setPalette(meta.palette);
            });
        } else {
            this._setArt(this._openArt, null);
            this._setArt(this._lyricsArt, null);
            this._gradPalette = null;
        }
    }

    _toggleLyricsMode() {
        this._lyricsMode = !this._lyricsMode;
        this._settings.set_boolean('lyrics-mode', this._lyricsMode);
        this._updateLyricsBtn();
        this._refreshClosedSize();
        this._refreshLyricsTimer();
    }

    _updateLyricsBtn() {
        if (!this._lyricsBtn) return;
        const avail = !!(this._lyrics && this._lyrics.length > 0);
        this._lyricsBtn.child.opacity = avail ? 255 : 90;
        if (this._lyricsMode) this._lyricsBtn.add_style_class_name('active');
        else this._lyricsBtn.remove_style_class_name('active');
    }

    _clearLyrics() {
        this._lyricsToken++;
        this._lyrics = null;
        this._trackKey = null;
        if (this._lyricsWidget) this._lyricsWidget.showEmpty();
        this._updateLyricsBtn();
        this._refreshClosedSize();
        this._refreshLyricsTimer();
    }

    _fetchLyrics(st) {
        if (!this._settings.get_boolean('enable-lyrics')) { this._clearLyrics(); return; }
        const token = ++this._lyricsToken;
        this._lyrics = null;
        this._updateLyricsBtn();
        this._refreshClosedSize();
        if (this._lyricsWidget) this._lyricsWidget.showLoading();

        const durSec = Math.round((st.lengthUs || 0) / 1e6);
        this._lyricsClient.getLyrics(st.title, st.artist, '', durSec, null)
            .then(lines => {
                if (token !== this._lyricsToken) return;
                if (lines && lines.length > 0) {
                    this._lyrics = lines;
                    if (this._lyricsWidget) this._lyricsWidget.setLyrics(lines);
                } else {
                    this._lyrics = null;
                    if (this._lyricsWidget) this._lyricsWidget.showEmpty();
                }
                this._afterLyrics();
            })
            .catch(() => {
                if (token !== this._lyricsToken) return;
                this._lyrics = null;
                if (this._lyricsWidget) this._lyricsWidget.showError();
                this._afterLyrics();
            });
    }

    _afterLyrics() {
        this._updateLyricsBtn();
        this._refreshClosedSize();
        this._refreshLyricsTimer();
    }

    _refreshLyricsTimer() {
        const st = this._media.getState();
        const playing = st.hasPlayer && st.status === 'Playing';
        const lyricsOn = this._lyricsActive();
        const want = lyricsOn && playing && !this._open;
        if (want && !this._lyricsTimer) {
            if (this._lyricsWidget) this._lyricsWidget.setPaused(false);
            this._lyricsTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                const s = this._media.getState();
                if (this._lyricsWidget && s.hasPlayer)
                    this._lyricsWidget.updatePosition(Math.round(s.positionUs / 1000));
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._lyricsTimer) {
            GLib.Source.remove(this._lyricsTimer);
            this._lyricsTimer = 0;
        }

        if (lyricsOn && !playing && this._lyricsWidget) {
            this._lyricsWidget.setPaused(true, st.title || '');
        }
    }

    _updateClosedDot() {
        if (!this._closedDot) return;
        const st = this._media.getState();
        const playing = st.hasPlayer && st.status === 'Playing';
        if (this._unread) {
            this._stopDotPulse();
            this._closedDot.set_style('background-color: #3ad15a; border-radius: 999px;');
            this._closedDot.visible = true;
        } else if (playing) {
            const a = this._accent;
            const col = a ? `rgb(${a.r},${a.g},${a.b})` : 'rgba(255,255,255,0.9)';
            this._closedDot.set_style(`background-color: ${col}; border-radius: 999px;`);
            this._closedDot.visible = true;
            this._startDotPulse();
        } else {
            this._stopDotPulse();
            this._closedDot.visible = false;
        }
    }

    _startDotPulse() {
        if (this._dotPulsing || !this._closedDot) return;
        this._dotPulsing = true;
        const breathe = (to, next) => {
            if (!this._dotPulsing || !this._closedDot) return;
            this._closedDot.ease({ opacity: to, duration: 950,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, onComplete: next });
        };
        const loop = () => breathe(110, () => breathe(255, loop));
        loop();
    }

    _stopDotPulse() {
        this._dotPulsing = false;
        if (this._closedDot) {
            this._closedDot.remove_all_transitions();
            this._closedDot.opacity = 255;
        }
    }

    _setArt(bin, artUrl) {
        if (artUrl && artUrl.length) {
            bin.set_style(`background-image: url("${artUrl}"); background-size: cover;`);
            bin.visible = true;
        } else {
            bin.set_style('');
            bin.visible = false;
        }
    }

    _updateScrubber(st) {
        const frac = st.lengthUs > 0 ? clamp01(st.positionUs / st.lengthUs) : 0;
        const trackW = this._scrubber.width || (this._openW - ART_OPEN - 60);
        this._scrubFill.set_width(Math.round(trackW * frac));
        this._posLabel.text = this._fmt(st.positionUs);
    }

    _updateDateTime() {
        const now = new Date();
        if (this._closedTime)
            this._closedTime.text = now.toLocaleTimeString([],
                { hour: 'numeric', minute: '2-digit' });
        if (this._headerDate)
            this._headerDate.text = now.toLocaleTimeString([],
                { hour: 'numeric', minute: '2-digit' });
    }

    _tick() {
        this._updateDateTime();
        const st = this._media.getState();
        if (st.hasPlayer && st.status === 'Playing' && this._openLayer.opacity > 0)
            this._updateScrubber(st);
    }

    _fmt(us) {
        if (!us || us < 0) us = 0;
        const s = Math.floor(us / 1e6);
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${sec < 10 ? '0' : ''}${sec}`;
    }

    _onDestroy() {
        this._anim.stop();
        this._clearCloseTimer();
        this._clearOpenTimer();
        this._clearPeekTimer();
        this._clearHudTimer();
        for (const id of this._transientTimeouts) GLib.Source.remove(id);
        this._transientTimeouts.clear();
        this._stopDotPulse();
        this._stopGradient();
        if (this._notifArrivedId) { this._notifications.disconnect(this._notifArrivedId); this._notifArrivedId = 0; }
        if (this._notifChangedId) { this._notifications.disconnect(this._notifChangedId); this._notifChangedId = 0; }
        if (this._notifications) { this._notifications.stop(); this._notifications = null; }
        if (this._shelfChangedId) { this._shelf.disconnect(this._shelfChangedId); this._shelfChangedId = 0; }
        if (this._shelf) { this._shelf.stop(); this._shelf = null; }
        if (this._shelfSettingId) { this._settings.disconnect(this._shelfSettingId); this._shelfSettingId = 0; }
        if (this._sizeIds) { for (const id of this._sizeIds) this._settings.disconnect(id); this._sizeIds = null; }
        if (this._lyricsSettingId) { this._settings.disconnect(this._lyricsSettingId); this._lyricsSettingId = 0; }
        if (this._themeIds) { for (const id of this._themeIds) this._settings.disconnect(id); this._themeIds = null; }
        this._lyricsToken++;
        if (this._lyricsTimer) { GLib.Source.remove(this._lyricsTimer); this._lyricsTimer = 0; }
        if (this._lyricsClient) { this._lyricsClient.destroy(); this._lyricsClient = null; }
        this._vkbd = null;
        if (this._tickId) { GLib.Source.remove(this._tickId); this._tickId = 0; }
        if (this._mediaId) { this._media.disconnect(this._mediaId); this._mediaId = 0; }
        if (this._calId) { this._calendar.disconnect(this._calId); this._calId = 0; }
        if (this._calendar) { this._calendar.stop(); this._calendar = null; }
        if (this._upower && this._battId) { this._upower.disconnect(this._battId); this._battId = 0; }
        this._upower = null;
    }
});
