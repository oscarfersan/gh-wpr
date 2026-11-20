#!/usr/bin/env bash
# <xbar.title>gh wpr</xbar.title>
# <xbar.desc>Whose turn it is on your pull requests, and AI review requests in one click.</xbar.desc>
# <xbar.abouturl>https://github.com/oscarfersan/gh-wpr</xbar.abouturl>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
#
# Installed by "gh wpr swiftbar install". Without arguments it prints the menu;
# menu actions call this same script with "gh wpr" arguments, so they get the
# PATH set up below as well.

# SwiftBar does not load your shell profile. Add the usual places for gh and
# node, lowest priority first (each one is put in front of the previous ones).
for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.volta/bin" \
	"$HOME/Library/Application Support/fnm/aliases/default/bin" \
	"$HOME/.local/share/fnm/aliases/default/bin"; do
	[ -d "$dir" ] && PATH="$dir:$PATH"
done
if [ -d "$HOME/.nvm/versions/node" ]; then
	latest="$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -n 1)"
	[ -n "$latest" ] && PATH="$HOME/.nvm/versions/node/$latest/bin:$PATH"
fi
# Anything else (a custom PATH, GH_WPR_NODE, ...) goes in this optional file.
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
# shellcheck disable=SC1091
[ -f "$config_home/gh-wpr/swiftbar.env" ] && . "$config_home/gh-wpr/swiftbar.env"
export PATH

GH_WPR_PLUGIN="${SWIFTBAR_PLUGIN_PATH:-$0}"
export GH_WPR_PLUGIN

if ! command -v gh >/dev/null 2>&1; then
	echo "⚠︎ | sfimage=exclamationmark.triangle"
	echo "---"
	echo "gh was not found. Install it or set PATH in $config_home/gh-wpr/swiftbar.env"
	exit 0
fi

if [ "$#" -eq 0 ]; then
	exec gh wpr swiftbar
fi
exec gh wpr "$@"
