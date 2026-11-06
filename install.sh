#!/usr/bin/env bash
# Installs the Quicktree mod into the Herdr app:
#   1. copies mods/quicktree into ~/.config/herdr-app/mods/quicktree (a copy, not a symlink:
#      Herdr's hot reload doesn't follow symlinked mod folders)
#   2. makes a personal layout "main-quicktree" (a clone of Herdr's main) with the
#      button under the Spaces list, and shows it
#   3. binds cmd-shift-n to it in keys.json (unless that key is taken)
# Re-run it after editing the mod to push the change in. Safe to run twice.
set -euo pipefail

HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LAYOUT="main-quicktree"
KEY="${QUICKTREE_KEY:-cmd-shift-n}"

command -v herdr-app >/dev/null || { echo "herdr-app not found on PATH" >&2; exit 1; }

# 1. The mod. Herdr writes jsconfig.json and gpui-kit.d.ts into the folder itself.
[ -L "$HOME_DIR/mods/quicktree" ] && rm "$HOME_DIR/mods/quicktree"
mkdir -p "$HOME_DIR/mods/quicktree"
rsync -a --delete --exclude jsconfig.json --exclude gpui-kit.d.ts "$HERE/mods/quicktree/" "$HOME_DIR/mods/quicktree/"
herdr-app check "$HOME_DIR/mods/quicktree"

# 2. The layout. Shipped layouts are read-only, so the button lives in a clone.
if [ ! -f "$HOME_DIR/layouts/$LAYOUT.json" ]; then
  herdr-app do layout.clone "{\"name\":\"main\",\"as\":\"$LAYOUT\"}" >/dev/null
fi
python3 - "$HOME_DIR/layouts/$LAYOUT.json" <<'EOF'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
def find(n, i):
    if n.get("id") == i: return n
    for c in n.get("children", []):
        r = find(c, i)
        if r: return r
if find(d, "quicktree"):
    sys.exit(0)
lists = find(d, "sidebar-lists")
if not lists:
    sys.exit("no sidebar-lists column in " + path + "; add {\"id\":\"quicktree\",\"type\":\"block\",\"size\":{\"px\":40},\"content\":{\"mod\":\"quicktree\"}} by hand")
ids = [c.get("id") for c in lists["children"]]
at = ids.index("spaces") + 1 if "spaces" in ids else len(ids)
lists["children"].insert(at, {"id": "quicktree", "type": "block", "size": {"px": 40}, "content": {"mod": "quicktree"}})
json.dump(d, open(path, "w"), indent=2)
EOF
herdr-app do layout.switch "{\"name\":\"$LAYOUT\"}" >/dev/null || true

# 3. The key.
python3 - "$HOME_DIR/keys.json" "$KEY" <<'EOF'
import json, os, sys
path, key = sys.argv[1], sys.argv[2]
d = json.load(open(path)) if os.path.exists(path) else {}
g = d.setdefault("global", {})
if g.get(key) == "mod.open:quicktree":
    sys.exit(0)
if key in g:
    print(f"keys.json: {key} is already {g[key]!r}; not rebinding. Set QUICKTREE_KEY to pick another.")
    sys.exit(0)
g[key] = "mod.open:quicktree"
json.dump(d, open(path, "w"), indent=2, ensure_ascii=False)
EOF

echo "quicktree installed. Layout: $LAYOUT (cmd-shift-l switches layouts). Key: $KEY."
