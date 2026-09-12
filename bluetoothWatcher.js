/**
 * bluetoothWatcher.js
 * Watches org.bluez on the system bus for Device1 connect/disconnect events.
 * Emits 'device-connected'   (name: str, battery: int|-1)
 * Emits 'device-disconnected'(name: str)
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Fetch a single D-Bus property synchronously (returns GLib.Variant or null)
function dbusGetProp(objectPath, iface, prop) {
    try {
        const ret = Gio.DBus.system.call_sync(
            'org.bluez', objectPath,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [iface, prop]),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, 2000, null);
        const [variant] = ret.deep_unpack();
        return variant.deep_unpack();
    } catch (_) { return null; }
}

export const BluetoothWatcher = GObject.registerClass({
    GTypeName: 'OrbitBluetoothWatcher',
    Signals: {
        'device-connected':    { param_types: [GObject.TYPE_STRING, GObject.TYPE_INT] },
        'device-disconnected': { param_types: [GObject.TYPE_STRING] },
    },
}, class BluetoothWatcher extends GObject.Object {

    _init() {
        super._init();
        // Subscribe to all PropertiesChanged on org.bluez.Device1 interfaces
        this._subId = Gio.DBus.system.signal_subscribe(
            'org.bluez',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            null,                               // all object paths
            null,                               // no arg0 filter (not all impls support it)
            Gio.DBusSignalFlags.NONE,
            (conn, _sender, objectPath, _iface, _signal, params) => {
                try {
                    const [ifaceName, changedProps] = params.deep_unpack();
                    if (ifaceName !== 'org.bluez.Device1') return;
                    if (!('Connected' in changedProps)) return;
                    const connected = changedProps['Connected'].deep_unpack();
                    this._onConnectionChanged(objectPath, connected);
                } catch (_) {}
            }
        );
    }

    _onConnectionChanged(objectPath, connected) {
        // Fetch device name
        const name = dbusGetProp(objectPath, 'org.bluez.Device1', 'Name') ?? 'Bluetooth Device';

        if (connected) {
            // Try to read battery level (org.bluez.Battery1, Percentage: byte)
            let battery = -1;
            const pct = dbusGetProp(objectPath, 'org.bluez.Battery1', 'Percentage');
            if (typeof pct === 'number') battery = pct;
            this.emit('device-connected', String(name), battery);
        } else {
            this.emit('device-disconnected', String(name));
        }
    }

    destroy() {
        if (this._subId) {
            Gio.DBus.system.signal_unsubscribe(this._subId);
            this._subId = 0;
        }
    }
});
