// Quicktree: sidebar buttons (and a key) that each open a new space on a
// configured folder, with the configured agent in the first pane and a plain
// terminal split to its right. In a git repo the space is a fresh worktree
// (unless that button turns it off); anywhere else it's the folder itself.
//
// One mod, four roles:
//   in the layout (no overlay prop)   the buttons
//   overlay, props.mode "settings"    set up one button (props.id; none: a new one)
//   overlay, props.mode "pick"        choose a button (the key, with several)
//   overlay, anything else            do it (props.id; none: the only button, else pick)

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, exec, home, knownAgents, pickFolder, shared, setShared, layout, keys, window, focused, panes } from "herdr";

// [{ id, folder, agent: {key, name, run}, model, prefix, worktree }]
const BUTTONS = "quicktree.buttons";
function buttons() {
  const list = shared(BUTTONS);
  return Array.isArray(list) ? list : [];
}
const byId = (id) => buttons().find((b) => b.id === id);
const saveButtons = (list) => setShared(BUTTONS, list);

// ROOT, slug and repoOf follow Herdr's shipped worktree mod (Apache-2.0).
// Same place the shipped worktree mod uses, so the spaces sidebar nests them under the repo.
const ROOT = () => `${home()}/.herdr/worktrees`;
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const tilde = (path) => (path && path.startsWith(home()) ? `~${path.slice(home().length)}` : path ?? "");
const expand = (path) => (path?.startsWith("~") ? home() + path.slice(1) : path);
const pad = (n) => String(n).padStart(2, "0");
const base = (path) => path.split("/").filter(Boolean).pop() ?? "/";
const parent = (path) => tilde(path.split("/").slice(0, -1).join("/") || "/");

async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The repo a folder belongs to: its main checkout and name. null outside git (or no such folder).
async function repoOf(folder) {
  let common;
  try { common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]); } catch { return null; }
  if (!common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { main, name: main.split("/").pop() };
}

// The agent's command line: its `run`, plus --model when one is set.
const argvOf = (b) => [...(b.agent?.run ?? ["claude"]), ...(b.model?.trim() ? ["--model", b.model.trim()] : [])];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function shortcut(action) {
  const k = keys().find((b) => b.section === "global" && b.action === action);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super" };
  const parts = k.keys.trim().split("-");
  const key = parts.pop();
  const held = new Set(parts);
  return [...Object.keys(names).filter((m) => held.has(m)).map((m) => names[m]), key.length === 1 ? key.toUpperCase() : key].join(mac ? "" : "+");
}

const ROW = 30;
const openSettings = (id) => openOverlay({ mod: "quicktree", kind: "dialog", width: 480, height: 520, props: { mode: "settings", id } });
const openRun = (id) => openOverlay({ mod: "quicktree", kind: "popup", at: "top", width: 460, height: 150, props: { mode: "run", id } });
const openPick = () => openOverlay({ mod: "quicktree", kind: "popup", at: "top", width: 420, height: 64 + buttons().length * ROW, props: { mode: "pick" } });
// The block's height: a row per button, then the add row.
const blockHeight = (n) => 10 + n * ROW + 28;

const icon = (b) => svg(`mods/workspace-chrome/${b.worktree === false ? "folder" : "branch"}.svg`);

export default class WorktreeNow extends View {
  init(_props, cx) {
    const mode = props()?.mode;
    this.role = !props()?.overlay ? "button" : mode === "settings" || mode === "pick" ? mode : "run";
    this.handle = cx.focus_handle();
    if (this.role === "settings") this.initSettings(cx);
    if (this.role === "pick") this.handle.focus();
    if (this.role === "run") {
      this.handle.focus();
      const list = buttons();
      const b = byId(props()?.id) ?? (list.length === 1 ? list[0] : null);
      if (!b) {
        // The key with no button picked: nothing to make yet, or which one?
        closeOverlay(props().overlay);
        list.length ? openPick() : openSettings();
        return;
      }
      this.button = b;
      this.step = "…";
      cx.spawn(async (cx) => this.work(cx));
    }
  }

  // ---- run -------------------------------------------------------------

  async work(cx) {
    const b = this.button;
    const folder = expand(b.folder);
    try {
      this.step = `Reading ${tilde(folder)}`;
      cx.notify();
      const repo = b.worktree === false ? null : await repoOf(folder);
      let path = folder;
      if (repo) {
        this.repo = repo;
        // wt/1105-1432, then wt/1105-1432-2 if that's taken.
        const d = new Date();
        const stem = `${b.prefix ?? "wt/"}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
        let branch = stem;
        for (let n = 2; (await git(repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok; n++) branch = `${stem}-${n}`;
        this.branch = branch;
        path = `${ROOT()}/${repo.name}/${slug(branch)}`;
        this.step = `git worktree add ${tilde(path)}`;
        cx.notify();
        const r = await git(folder, ["worktree", "add", "-b", branch, path, "HEAD"]);
        if (!r.ok) throw new Error(r.err || "git worktree add failed.");
      }

      this.step = "Opening the space";
      cx.notify();
      // Unnamed, so the space follows its folder (and a worktree nests under its repo).
      run("space.new", { folder: path, machine: "", tab: b.agent?.name ?? "agent", argv: argvOf(b) });
      run("terminal.open", { folder: path, place: "right" });
      // The split takes the keyboard; hand it back to the agent once the tab has both panes
      // (pane.go goes by geometry, which isn't laid out yet).
      await cx.sleep(150);
      const f = focused();
      const agent = panes().find((p) => p.tab === f?.tab && p.pane !== f?.pane);
      if (agent) run("pane.focus", { pane: agent.pane });
      closeOverlay(props().overlay);
    } catch (error) {
      this.error = String(error?.message ?? error);
      cx.notify();
    }
  }

  renderRun(t) {
    const b = this.button ?? {};
    const title = this.repo ? `New worktree of ${this.repo.name}` : `New space in ${base(b.folder ?? "")}`;
    return v_flex().id("qt-run").track_focus(this.handle)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(props().overlay); })
      .size_full().p(16).gap(8).bg(t.popover).text_size(13)
      .child(h_flex().gap(8).items_center()
        .child(icon(b).size(14).text_color(t.accent))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.dim).child(b.agent?.name ?? "")))
      .when(Boolean(this.branch), (el) => el.child(div().text_color(t.muted).truncate().child(this.branch)))
      .when(!this.error, (el) => el.child(div().text_color(t.dim).truncate().child(this.step)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child(this.error ? "esc close" : "working…"));
  }

  // ---- pick ------------------------------------------------------------

  choosePick(b) {
    if (!b) return;
    closeOverlay(props().overlay);
    openRun(b.id);
  }

  renderPick(t) {
    const list = buttons();
    return v_flex().id("qt-pick").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props().overlay);
        if (e.key === "enter") return this.choosePick(list[0]);
        if (/^[1-9]$/.test(e.key)) { cx.stop_propagation(); this.choosePick(list[Number(e.key) - 1]); }
      })
      .size_full().p(6).bg(t.popover).text_size(13)
      .child(div().px(9).pt(4).pb(6).text_size(11).text_color(t.dim).child("Quicktree"))
      .children(list.map((b, i) => h_flex().id(`pick-${b.id}`).h(ROW).px(9).gap(10).items_center().rounded(7).flex_none().cursor_pointer()
        .hover((s) => s.bg(t.selected)).on_click(() => this.choosePick(b))
        .child(icon(b).size(14).text_color(t.muted))
        .child(div().flex_none().text_color(t.foreground).child(base(b.folder)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(b.agent?.name ?? ""))
        .child(div().text_size(11).text_color(t.dim).child(i < 9 ? String(i + 1) : ""))));
  }

  // ---- settings --------------------------------------------------------

  initSettings(cx) {
    const b = byId(props()?.id) ?? {};
    this.editing = b.id ?? null;
    this.agent = b.agent ?? null;
    this.worktree = b.worktree !== false;
    this.agents = [];
    this.error = "";
    this.repo = undefined; // undefined: checking, null: not in git
    const field = (value, placeholder, changed) => {
      const s = InputState.new({ value: value ?? "", placeholder });
      s.on("submit", (_e, cx) => this.save(cx));
      s.on("change", (_e, cx) => { this.error = ""; changed?.(cx); cx.notify(); });
      return s;
    };
    this.folder = field(tilde(b.folder), "~/Code/my-repo", (cx) => this.checkRepo(cx));
    this.model = field(b.model, "default (e.g. opus, sonnet, gpt-5-codex)");
    this.prefix = field(b.prefix ?? "wt/", "wt/");
    this.folder.focus();
    cx.timer.after(300, () => this.folder.focus());
    this.checkRepo(cx);
    cx.spawn(async (cx) => {
      try {
        this.agents = (await knownAgents({ on: null })).filter((a) => a.installed);
        if (!this.agent && this.agents[0]) this.agent = pick(this.agents[0]);
      } catch { this.agentsFailed = true; }
      cx.notify();
    });
  }

  // Whether the folder is in git, for the worktree switch's note. The latest typing wins.
  checkRepo(cx) {
    const folder = expand(this.folder.value().trim());
    const ask = (this.asked = (this.asked ?? 0) + 1);
    cx.spawn(async (cx) => {
      const repo = folder ? await repoOf(folder) : null;
      if (ask !== this.asked) return;
      this.repo = repo;
      cx.notify();
    });
  }

  choose(cx) {
    cx.spawn(async (cx) => {
      const f = await pickFolder({ prompt: "Use" });
      if (f) { this.folder.set_value(tilde(f)); this.error = ""; this.checkRepo(cx); }
      cx.notify();
    });
  }

  save(cx) {
    cx.spawn(async (cx) => {
      const folder = expand(this.folder.value().trim()).replace(/(.)\/+$/, "$1");
      if (!folder) { this.error = "Pick a starting folder."; return cx.notify(); }
      let ok = false;
      try { ok = (await exec("test", ["-d", folder])).code === 0; } catch {}
      if (!ok) { this.error = `${tilde(folder)} is not a folder.`; return cx.notify(); }
      if (!this.agent) { this.error = "Pick an agent."; return cx.notify(); }
      // Outside git there's nothing to branch: say so up front (the button shows a folder).
      const worktree = this.worktree && (await repoOf(folder)) !== null;
      const b = {
        id: this.editing ?? `b${Date.now().toString(36)}`,
        folder, agent: this.agent, model: this.model.value().trim(),
        prefix: this.prefix.value().trim() || "wt/", worktree,
      };
      const list = buttons();
      saveButtons(this.editing ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b]);
      closeOverlay(props().overlay);
    });
  }

  remove() {
    saveButtons(buttons().filter((b) => b.id !== this.editing));
    closeOverlay(props().overlay);
  }

  renderSettings(t) {
    const label = (s) => div().text_size(11).text_color(t.dim).child(s);
    const input = (state) => Input.new(state).h(30).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground);
    const button = (id, text, kind, action) => div().id(id).h(30).px(12).flex().items_center().rounded(6).cursor_pointer()
      .when(kind === "primary", (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(kind === "danger", (el) => el.text_color(t.blocked).hover((s) => s.bg(t.hover)))
      .when(kind === "plain", (el) => el.border(1).border_color(t.input).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => action(cx)).child(text);
    const agentRow = (a) => {
      const on = this.agent?.key === a.key;
      return h_flex().id(`agent-${a.key}`).h(30).px(9).gap(10).items_center().rounded(6).flex_none().cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.agent = pick(a); this.error = ""; cx.notify(); })
        .child(a.icon ? (a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14)) : div().w(14))
        .child(div().flex_1().text_color(t.foreground).child(a.name))
        .child(div().text_size(11).text_color(t.dim).child(a.run.join(" ")));
    };
    const note = this.repo === undefined ? "" : this.repo === null
      ? "Not a git repo: opens the folder itself, no worktree."
      : this.worktree ? `A new branch and worktree of ${this.repo.name} each time.` : "Opens the folder itself, no worktree.";
    const checked = this.worktree && this.repo !== null;
    const toggle = h_flex().id("worktree-toggle").gap(8).items_center().cursor_pointer()
      .when(this.repo === null, (el) => el.opacity(0.5))
      .on_click((_e, cx) => { this.worktree = !this.worktree; cx.notify(); })
      .child(div().size(14).flex_none().rounded(3).border(1).border_color(checked ? t.accent : t.input)
        .bg(checked ? t.accent : t.background).flex().items_center().justify_center()
        .when(checked, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(11).text_color(t.accent_foreground))))
      .child(div().text_color(t.foreground).child("Make a worktree"));
    return v_flex().id("qt-settings").track_focus(this.handle)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(props().overlay); })
      .size_full().p(16).gap(8).bg(t.popover).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(this.editing ? "Edit quicktree button" : "New quicktree button"))
      .child(div().text_color(t.muted).child("Opens a new space on this folder: the agent on the left, a terminal on the right."))
      .child(label("Starting folder"))
      .child(h_flex().gap(6).child(div().flex_1().child(input(this.folder))).child(button("choose", "Choose…", "plain", (cx) => this.choose(cx))))
      .child(h_flex().gap(10).items_center().child(toggle).child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(note)))
      .child(label("Agent"))
      .child(v_flex().h(124).overflow_y_scrollbar().children(this.agents.map(agentRow))
        .when(this.agents.length === 0, (el) => el.child(div().px(9).py(6).text_color(t.dim).child(this.agentsFailed ? "Could not load agents." : "Checking installed agents…"))))
      .child(h_flex().gap(8)
        .child(v_flex().flex_1().gap(4).child(label("Model (passed as --model)")).child(input(this.model)))
        .child(v_flex().w(110).gap(4).child(label("Branch prefix")).child(input(this.prefix))))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).items_center()
        .when(Boolean(this.editing), (el) => el.child(button("delete", "Delete", "danger", () => this.remove())))
        .child(div().flex_1().text_size(11).text_color(t.dim).child("↵ save · esc cancel"))
        .child(button("cancel", "Cancel", "plain", () => closeOverlay(props().overlay)))
        .child(button("save", "Save", "primary", (cx) => this.save(cx))));
  }

  // ---- buttons ---------------------------------------------------------

  renderButtons(t) {
    const list = buttons();
    // Grow the block to fit its rows (a personal layout keeps the size).
    const height = blockHeight(list.length);
    if (find(layout(), "quicktree") && this.height !== height) {
      this.height = height;
      run("layout.resize", { id: "quicktree", px: height });
    }
    const rail = narrow();
    const hint = list.length === 1 ? shortcut("mod.open:quicktree") : "";
    const row = (b) => h_flex().id(`row-${b.id}`).h(ROW).gap(2).items_center().flex_none()
      .child(h_flex().id(`go-${b.id}`).h(28).px(8).gap(9).items_center().rounded(8).min_w(0).cursor_pointer()
        .when(!rail, (el) => el.flex_1())
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => openRun(b.id))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openSettings(b.id); })
        .child(icon(b).size(14).flex_none())
        // The folder's name first, where it lives after: the start of a long path is the least telling part.
        .when(!rail, (el) => el
          .child(h_flex().flex_1().min_w(0).gap(6).items_baseline()
            .child(div().flex_none().text_color(t.foreground).child(base(b.folder)))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parent(b.folder))))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(hint))))
      .when(!rail, (el) => el.child(div().id(`gear-${b.id}`).size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(() => openSettings(b.id))
        .child(svg("mods/workspace-chrome/settings.svg").size(13))));
    const add = h_flex().id("qt-add").h(26).px(8).gap(9).items_center().rounded(8).flex_none().cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => openSettings())
      .child(svg("mods/workspace-chrome/plus.svg").size(13).flex_none())
      .when(!rail, (el) => el.child(div().text_size(12).child("New quicktree button")));
    return v_flex().id("quicktree").size_full().bg(t.chrome).px(8).pt(4).justify_end().text_size(13)
      .children(list.map(row))
      .child(add);
  }

  render() {
    const t = theme();
    if (this.role === "settings") return this.renderSettings(t);
    if (this.role === "pick") return this.renderPick(t);
    if (this.role === "run") return this.renderRun(t);
    return this.renderButtons(t);
  }
}

// What's kept of an agent: enough to start it and show its name.
const pick = (a) => ({ key: a.key, name: a.name, run: a.run });
