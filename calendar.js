import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

const CALENDAR_XML = `
<node>
  <interface name="org.gnome.Shell.CalendarServer">
    <method name="SetTimeRange">
      <arg type="x" direction="in" name="since"/>
      <arg type="x" direction="in" name="until"/>
      <arg type="b" direction="in" name="force_reload"/>
    </method>
    <signal name="EventsAddedOrUpdated">
      <arg type="a(ssxxa{sv})" name="events"/>
    </signal>
    <signal name="EventsRemoved"><arg type="as" name="ids"/></signal>
    <property name="Events" type="a(ssxxa{sv})" access="read"/>
    <property name="HasCalendars" type="b" access="read"/>
  </interface>
</node>`;

const CalendarProxy = Gio.DBusProxy.makeProxyWrapper(CALENDAR_XML);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const OrbitCalendar = GObject.registerClass({
    Signals: { 'updated': {} },
}, class OrbitCalendar extends GObject.Object {
    _init() {
        super._init();
        this._events = [];
        this._proxy = null;
        this._sigIds = [];
        this._selected = new Date();
        const d = startOfDay(new Date());
        d.setDate(d.getDate() - d.getDay());
        this._anchor = d;
    }

    start() {
        try {
            this._proxy = CalendarProxy(Gio.DBus.session,
                'org.gnome.Shell.CalendarServer', '/org/gnome/Shell/CalendarServer');

            this._sigIds.push(this._proxy.connectSignal('EventsAddedOrUpdated',
                (_p, _s, [t]) => this._onEvents(t)));
            this._sigIds.push(this._proxy.connectSignal('EventsRemoved',
                (_p, _s, [ids]) => { this._events = this._events.filter(e => !ids.includes(e.id)); this.emit('updated'); }));

            this._ownerId = this._proxy.connect('notify::g-name-owner', () => {
                if (this._proxy.g_name_owner) this._requestRange();
            });
            if (this._proxy.g_name_owner) this._requestRange();
        } catch (e) {
            console.debug(`orbit: calendar start failed: ${e.message}`);
        }
    }

    stop() {
        if (this._proxy) {
            if (this._ownerId) this._proxy.disconnect(this._ownerId);
            for (const id of this._sigIds) { try { this._proxy.disconnectSignal(id); } catch (e) {} }
            this._sigIds = [];
            this._proxy = null;
        }
        this._events = [];
    }

    _requestRange() { this._requestRangeAround(this._anchor); }

    _requestRangeAround(date) {
        if (!this._proxy) return;
        const since = Math.floor(startOfDay(date).getTime() / 1000) - 86400;
        const until = since + 86400 * 14;
        try {
            this._proxy.SetTimeRangeRemote(since, until, true, (_r, err) => {
                if (!err) this._pull();
            });
        } catch (e) { console.debug(`orbit: SetTimeRange failed: ${e.message}`); }
    }

    shiftDays(n) {
        this._anchor = new Date(this._anchor.getFullYear(), this._anchor.getMonth(),
                                this._anchor.getDate() + n);
        this._requestRangeAround(this._anchor);
        this.emit('updated');
    }

    _pull() {
        if (!this._proxy || !this._proxy.g_name_owner) return;
        this._proxy.get_connection().call(
            this._proxy.g_name, this._proxy.g_object_path,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.gnome.Shell.CalendarServer', 'Events']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [variant] = conn.call_finish(res).recursiveUnpack();
                    if (variant) this._onEvents(variant);
                } catch (e) {  }
            });
    }

    _onEvents(tuples) {
        if (!tuples) return;
        for (const [id, summary, start, end, extras] of tuples) {
            let allDay = false;
            try { if (extras && extras['all-day']) allDay = !!extras['all-day'].unpack(); } catch (e) {}
            const ev = { id, summary, allDay, start: Number(start), end: Number(end) };
            const i = this._events.findIndex(e => e.id === id);
            if (i >= 0) this._events[i] = ev; else this._events.push(ev);
        }
        this._events.sort((a, b) => a.start - b.start);
        this.emit('updated');
    }

    resetSelected() {
        const today = new Date();
        this._selected = today;
        const d = startOfDay(today);
        d.setDate(d.getDate() - d.getDay());
        this._anchor = d;
        this._requestRangeAround(this._anchor);
    }

    _eventsForDay(date) {
        const s = startOfDay(date).getTime() / 1000;
        const e = s + 86400;
        return this._events.filter(ev => ev.start < e && ev.end > s);
    }

    render() {
        const box = new St.BoxLayout({
            style_class: 'orbit-cal', vertical: true,
            x_expand: true, y_expand: true,
        });

        const today = new Date();
        const anchor = this._anchor;

        const header = new St.BoxLayout({
            style_class: 'orbit-cal-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const monthCol = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.CENTER });
        monthCol.add_child(new St.Label({
            style_class: 'orbit-cal-month', text: MONTHS[anchor.getMonth()] }));
        monthCol.add_child(new St.Label({
            style_class: 'orbit-cal-year', text: `${anchor.getFullYear()}` }));
        header.add_child(monthCol);
        header.add_child(new St.Widget({ x_expand: true }));

        const nav = new St.BoxLayout({
            style_class: 'orbit-cal-nav',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const prev = new St.Button({
            style_class: 'orbit-cal-navbtn', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        prev.set_child(new St.Icon({ icon_name: 'pan-start-symbolic', icon_size: 14 }));
        prev.connect('clicked', () => this.shiftDays(-7));
        nav.add_child(prev);

        const sel = this._selected;
        const strip = new St.BoxLayout({
            style_class: 'orbit-cal-strip', reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (let i = 0; i < 7; i++) {
            const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i);
            const isToday = sameDay(d, today);
            const isSel = sameDay(d, sel);

            const cell = new St.Button({ style_class: 'orbit-cal-cell', can_focus: true });
            const col = new St.BoxLayout({ vertical: true, x_align: Clutter.ActorAlign.CENTER });
            col.add_child(new St.Label({
                style_class: isToday ? 'orbit-cal-wd today' : 'orbit-cal-wd',
                text: WEEKDAYS[d.getDay()],
                x_align: Clutter.ActorAlign.CENTER,
            }));

            let discClass = 'orbit-cal-disc';
            if (isToday) discClass += ' today';
            else if (isSel) discClass += ' sel';
            const disc = new St.Bin({ style_class: discClass, x_align: Clutter.ActorAlign.CENTER });
            disc.set_size(30, 30);
            const num = new St.Label({ style_class: 'orbit-cal-num', text: `${d.getDate()}` });
            num.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
            disc.set_child(num);
            col.add_child(disc);

            cell.set_child(col);
            cell.connect('clicked', () => { this._selected = d; this.emit('updated'); });
            strip.add_child(cell);
        }

        strip.connect('scroll-event', (_a, ev) => {
            const dir = ev.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) {
                this.shiftDays(-7); return Clutter.EVENT_STOP;
            }
            if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) {
                this.shiftDays(7); return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        nav.add_child(strip);

        const next = new St.Button({
            style_class: 'orbit-cal-navbtn', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        next.set_child(new St.Icon({ icon_name: 'pan-end-symbolic', icon_size: 14 }));
        next.connect('clicked', () => this.shiftDays(7));
        nav.add_child(next);

        header.add_child(nav);
        box.add_child(header);

        const scroll = new St.ScrollView({
            style_class: 'orbit-cal-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const list = new St.BoxLayout({ style_class: 'orbit-cal-events', vertical: true, x_expand: true });

        const events = this._eventsForDay(sel);
        if (events.length === 0) {
            list.add_child(new St.Label({
                style_class: 'orbit-cal-empty',
                text: sameDay(sel, today) ? 'No events today' : 'No events',
            }));
        } else {
            for (const ev of events) list.add_child(this._eventRow(ev));
        }
        scroll.set_child(list);
        box.add_child(scroll);
        return box;
    }

    _eventRow(ev) {
        const row = new St.BoxLayout({ style_class: 'orbit-cal-event' });

        const timeBox = new St.BoxLayout({
            style_class: 'orbit-cal-time', vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (ev.allDay) {
            timeBox.add_child(new St.Label({ style_class: 'orbit-cal-time-main', text: 'All-day' }));
        } else {
            timeBox.add_child(new St.Label({
                style_class: 'orbit-cal-time-main', text: this._fmtTime(ev.start) }));
            timeBox.add_child(new St.Label({
                style_class: 'orbit-cal-time-sub', text: this._fmtTime(ev.end) }));
        }
        row.add_child(timeBox);

        row.add_child(new St.Icon({
            style_class: 'orbit-cal-check',
            icon_name: 'emblem-ok-symbolic',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const title = new St.Label({
            style_class: 'orbit-cal-title', text: ev.summary || '(no title)',
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.set_line_wrap(true);
        title.x_expand = true;
        row.add_child(title);

        return row;
    }

    _fmtTime(unixSec) {
        const d = new Date(unixSec * 1000);
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
});
