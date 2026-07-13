UUID   := orbit@unmade.space
PREFIX := $(HOME)/.local/share/gnome-shell/extensions
DEST   := $(PREFIX)/$(UUID)
FILES  := metadata.json extension.js notch.js mediaController.js spring.js \
          calendar.js visualizer.js notifications.js shelf.js themes.js \
          lyricsClient.js lyricsWidget.js prefs.js stylesheet.css schemas

.PHONY: all compile-schemas install uninstall enable disable logs

all: compile-schemas

compile-schemas:
	glib-compile-schemas schemas/

install: compile-schemas
	mkdir -p "$(DEST)"
	cp -r $(FILES) "$(DEST)/"

uninstall:
	rm -rf "$(DEST)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i -E "orbit|notch"
