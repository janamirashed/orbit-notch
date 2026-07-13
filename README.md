# Orbit Notch

A pill at the top centre of your screen. Collapsed it shows the time, a status
dot and a live equaliser; on a deliberate hover it springs open into a hub with
media controls, a calendar, notification history and a temporary files shelf.

## Features

- MPRIS media controls: album art, title, scrubbing, transport buttons
- Synced lyrics (lrclib.net) with a wide scrolling lyrics pill
- Notification peeks with per-app ignore list, grouped history, two-way sync
  with the shell's own notification list
- Files shelf: paste files or images in with Ctrl+V, click a card to paste
  them into the focused app
- Pressure-style hover activation: configurable open/close delays and a
  subtle swell while the timer runs, so a passing cursor never triggers it
- Themes for collapsed and expanded state independently, including a
  background blur theme that follows Blur my Shell's settings when installed

## Install

    git clone https://github.com/Unmade760/orbit-notch.git
    cd orbit-notch
    make install

GNOME Shell only picks up newly installed extensions at login, so log out
and back in, then run:

    gnome-extensions enable orbit@unmade.space

The same applies after updating: log out and back in for code changes to
take effect on Wayland.

## Themes

Drop a JSON file into `~/.config/orbit/themes/`:

    {
        "id": "glass",
        "name": "Glass",
        "fill": "#10141aa8",
        "text": "#e8e8e8",
        "blur": true
    }

`fill` accepts `#rrggbb`, `#rrggbbaa` or `[r, g, b, alpha]` with 0-255
channels and 0-1 alpha. `blurRadius` and `blurBrightness` override the values
otherwise taken from Blur my Shell. Select the theme in the extension
preferences; unknown ids fall back to the default theme.

## Requirements

- GNOME Shell 49 or 50
- `cava` (optional) for the equaliser
