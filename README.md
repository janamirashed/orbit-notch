# Orbit Dynamic Island

An iOS-inspired Dynamic Island and top-screen notch hub for GNOME Shell.

When collapsed, Orbit Dynamic Island sits unobtrusively at the top center of your display, showing active media playback, running timers, or hardware privacy states. On deliberate cursor hover or click, it fluidly expands into a comprehensive media and productivity dashboard.

This project is an enhanced fork of [orbit-notch](https://github.com/Unmade760/orbit-notch) by [Unmade760](https://github.com/Unmade760), adding native OSD interception, Pomodoro focus workflows, persistent task management, desktop accent color synchronization, and improved containerized browser compatibility.

---

## Features

### Dynamic Island HUD (System OSD Interception)
- **Volume and Brightness HUD**: Intercepts native GNOME on-screen displays (OSD) and renders them directly inside the notch pill with animated progress bars.
- **Power State Alerts**: Displays brief HUD feedback when AC power is connected or disconnected.
- **Scroll-to-Adjust Volume**: Hover over the collapsed notch and scroll with your mouse wheel or trackpad to adjust system volume directly.

### Productivity Center (Focus Timer and Tasks)
- **Pomodoro Focus Timer**: Dedicated Focus mode supporting configurable intervals (25m Focus, 5m Short Break, 15m Long Break) with automatic phase switching and completion alerts.
- **Stopwatch and Countdown**: Integrated stopwatch and custom countdown timer options.
- **Pill Time Display**: Active timers and focus intervals display elapsed/remaining time directly in the closed pill.
- **Scrollable Layout**: Adaptive inner container prevents control buttons from overflowing on compact displays.
- **Task Checklist**: Integrated directly into the Shelf view:
  - Add tasks instantly with the Return key.
  - Circular toggle controls with strikethrough completion styling.
  - Persistent state saved to `~/.cache/orbit/tasks.json`.
  - Batch action to clear completed tasks.

### Media Controller and Synced Lyrics
- **Universal MPRIS Support**: Full transport controls (play, pause, skip, scrub), track metadata, and album artwork.
- **Sandboxed Browser Artwork Fix**: Resolves private container paths (`/proc/<pid>/root/tmp/`) for browsers installed via Snap or Flatpak (e.g., Brave and Chromium) to ensure album art loads properly.
- **Real-Time Synced Lyrics**: Fetches synchronized lyrics via LRCLIB and renders them in an active scrolling display.

### Notification Peeks
- **Transient Banner Peeks**: Important incoming notifications expand smoothly from the pill without disrupting your workflow.
- **Progressive Web App (PWA) Icon Resolution**: Automatically resolves desktop icons for Chromium-based web application shortcuts (WhatsApp, Instagram, Telegram, etc.).
- **Rich Text Formatting**: Safely parses Pango markup (bold, italics, underline) used by notification clients.
- **Critical Alert Handling**: Priority and urgent notifications reliably bypass Do-Not-Disturb filters.

### Hardware Privacy Indicators
- Live status indicators for active microphone and webcam hardware capture.

### Desktop Integration and Theming
- **GNOME Accent Color Sync**: Weekday labels and current-day highlights automatically inherit your system appearance accent color (`org.gnome.desktop.interface accent-color`).
- **Clean Notch Header**: Redundant system tray clutter (battery, duplicate clocks) removed for a minimal, focused appearance.
- **Full-Width Calendar**: Expanded layout utilizing the full width of the hub.

---

## Requirements

- **GNOME Shell**: 49 or 50
- **Audio Server**: PipeWire (`wpctl`) or PulseAudio (`pactl`)
- **Visualizer** *(optional)*: `cava`

---

## Installation

### 1. Clone the repository
```bash
git clone https://github.com/janamirashed/orbit-notch.git
cd orbit-notch
```

### 2. Deploy to GNOME extensions directory
```bash
mkdir -p ~/.local/share/gnome-shell/extensions/orbit-dynamic-island@janamirashed
cp -r * ~/.local/share/gnome-shell/extensions/orbit-dynamic-island@janamirashed/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/orbit-dynamic-island@janamirashed/schemas/
```

### 3. Reload GNOME Shell
- **Wayland**: Log out and log back in.
- **X11**: Press `Alt + F2`, enter `r`, and press `Enter`.

### 4. Enable the extension
```bash
gnome-extensions enable orbit-dynamic-island@janamirashed
```

---

## Theming

Custom theme configurations can be placed in `~/.config/orbit/themes/` as JSON files:

```json
{
    "id": "glass",
    "name": "Glass",
    "fill": "#10141aa8",
    "text": "#e8e8e8",
    "blur": true
}
```

Hex color formats (`#rrggbb`, `#rrggbbaa`) and array notations (`[r, g, b, alpha]`) are supported. Select your active theme via the extension preferences dialog.

---

## Credits and License

- Based on the original [orbit-notch](https://github.com/Unmade760/orbit-notch) project by [Unmade760](https://github.com/Unmade760).
- Synced lyrics provided by [LRCLIB](https://lrclib.net).
- Licensed under the [GNU General Public License v2.0](LICENSE).
