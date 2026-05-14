/**
 * Slash Favorites Extension
 *
 * Star/unstar slash commands so favorites appear first when you type `/`.
 *
 *   /favorites       open the star manager
 *
 * Persistence: ~/.pi/agent/data/slash-favorites.json   (ordered array)
 *
 * Implementation:
 *   Instead of replacing pi's editor (which would clobber other extensions
 *   that style/customize the editor — and break pi's welcome screen), we
 *   monkey-patch `CombinedAutocompleteProvider.prototype.getSuggestions`
 *   once. The patch only modifies slash-command results:
 *     - When prefix is exactly "/", reorders items so favorites come first
 *       in user order, with non-favorites following.
 *     - Decorates every slash item's label with ★ (yellow) for starred
 *       entries, "  " (two spaces) for unstarred — so columns align.
 *   Original `item.value` is left untouched so completion still inserts
 *   the bare `/name`.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Local mirror of pi's built-in slash commands ────────────────────────────
// pi.getCommands() only returns extension/prompt/skill sources, so we keep
// this list in sync manually for the picker. Update if pi adds new builtins.
const BUILTIN_COMMANDS = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: "Quit pi" },
] as const;

// ─── Catppuccin-ish colors ───────────────────────────────────────────────────
const C = {
	mantle: "24;24;37",
	text: "205;214;244",
	subtext0: "166;173;200",
	overlay1: "127;132;156",
	overlay0: "108;112;134",
	surface1: "69;71;90",
	surface0: "49;50;68",
	yellow: "249;226;175",
	mauve: "203;166;247",
	peach: "250;179;135",
};
const fg = (rgb: string, s: string) => `\x1b[38;2;${rgb}m${s}\x1b[39m`;
const bg = (rgb: string, s: string) => `\x1b[48;2;${rgb}m${s}\x1b[49m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
function padTo(width: number, s: string): string {
	const w = visibleWidth(s);
	if (w >= width) return truncateToWidth(s, width, "");
	return s + " ".repeat(width - w);
}

const STAR_LABEL_PREFIX = fg(C.yellow, "★") + " ";
const PLAIN_LABEL_PREFIX = "  ";

// ─── Persistence (ordered array) ─────────────────────────────────────────────
const FAV_PATH = join(process.env.HOME || "", ".pi/agent/data/slash-favorites.json");

function loadOrder(): string[] {
	try {
		const raw = readFileSync(FAV_PATH, "utf8");
		const arr = JSON.parse(raw);
		if (Array.isArray(arr)) {
			const seen = new Set<string>();
			const out: string[] = [];
			for (const x of arr) {
				if (typeof x === "string" && !seen.has(x)) {
					seen.add(x);
					out.push(x);
				}
			}
			return out;
		}
	} catch {}
	return [];
}

class FavStore {
	private order: string[];
	private set: Set<string>;
	constructor(initial: string[]) {
		this.order = [...initial];
		this.set = new Set(initial);
	}
	has(n: string): boolean {
		return this.set.has(n);
	}
	list(): string[] {
		return [...this.order];
	}
	indexOf(n: string): number {
		return this.order.indexOf(n);
	}
	add(n: string): void {
		if (this.set.has(n)) return;
		this.set.add(n);
		this.order.push(n);
	}
	remove(n: string): void {
		if (!this.set.has(n)) return;
		this.set.delete(n);
		this.order = this.order.filter((x) => x !== n);
	}
	toggle(n: string): boolean {
		if (this.set.has(n)) {
			this.remove(n);
			return false;
		}
		this.add(n);
		return true;
	}
	move(n: string, delta: number): boolean {
		const i = this.order.indexOf(n);
		if (i < 0) return false;
		const j = i + delta;
		if (j < 0 || j >= this.order.length) return false;
		[this.order[i], this.order[j]] = [this.order[j], this.order[i]];
		return true;
	}
	save(): void {
		try {
			mkdirSync(dirname(FAV_PATH), { recursive: true });
			writeFileSync(FAV_PATH, JSON.stringify(this.order, null, 2));
		} catch {}
	}
}

// ─── Prototype patch (the only side effect on pi) ────────────────────────────
let patched = false;

function patchAutocomplete(favs: FavStore) {
	if (patched) return;
	patched = true;
	const proto = CombinedAutocompleteProvider.prototype as any;
	const original = proto.getSuggestions;
	if (typeof original !== "function") return;
	proto.getSuggestions = async function patchedGetSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: any,
	) {
		const result = await original.call(this, lines, cursorLine, cursorCol, options);
		if (!result) return result;
		const prefix: string = result.prefix ?? "";
		// Only touch slash-command results — leave @file / path completion alone.
		const isSlash = prefix.startsWith("/") && !prefix.slice(1).includes("/");
		if (!isSlash) return result;

		let items = result.items as Array<{ value: string; label?: string; description?: string }>;
		// When the user has typed just "/" (no query yet), surface favorites first
		// in user-defined order. For "/foo" we keep the fuzzy ranking pi computed.
		if (prefix === "/") {
			const order = favs.list();
			const favSet = new Set(order);
			const byName = new Map(items.map((it) => [it.value, it]));
			const favList: typeof items = [];
			for (const name of order) {
				const it = byName.get(name);
				if (it) favList.push(it);
			}
			const rest = items.filter((it) => !favSet.has(it.value));
			items = [...favList, ...rest];
		}
		// Decorate labels with ★ regardless of query so the marker is always visible.
		items = items.map((it) => {
			const baseLabel = it.label || it.value;
			const prefixChar = favs.has(it.value) ? STAR_LABEL_PREFIX : PLAIN_LABEL_PREFIX;
			return { ...it, label: `${prefixChar}${baseLabel}` };
		});
		return { ...result, items };
	};
}

// ─── Command list assembly (for the picker) ──────────────────────────────────
interface Cmd {
	name: string;
	description?: string;
}

function getAllCommands(pi: ExtensionAPI): Cmd[] {
	const all = new Map<string, Cmd>();
	for (const b of BUILTIN_COMMANDS) all.set(b.name, { name: b.name, description: b.description });
	for (const e of pi.getCommands() as SlashCommandInfo[]) {
		if (!all.has(e.name)) all.set(e.name, { name: e.name, description: e.description });
	}
	return [...all.values()];
}

// ─── Favorites picker overlay ────────────────────────────────────────────────
class FavoritesPicker {
	private filter = "";
	private selected = 0;
	private scroll = 0;
	private items: Cmd[];
	private cachedHeight?: number;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onClose?: () => void;

	constructor(
		private allCommands: Cmd[],
		private favs: FavStore,
	) {
		this.items = this.computeItems();
	}

	private computeItems(): Cmd[] {
		const byName = new Map(this.allCommands.map((c) => [c.name, c]));
		const starred: Cmd[] = [];
		for (const name of this.favs.list()) {
			const c = byName.get(name);
			if (c) starred.push(c);
		}
		const rest = this.allCommands
			.filter((c) => !this.favs.has(c.name))
			.sort((a, b) => a.name.localeCompare(b.name));
		const f = this.filter.trim().toLowerCase();
		if (!f) return [...starred, ...rest];
		const match = (c: Cmd) =>
			c.name.toLowerCase().includes(f) ||
			(c.description ?? "").toLowerCase().includes(f);
		return [...starred.filter(match), ...rest.filter(match)];
	}

	invalidate() {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
	}

	private rebuildKeepingSelection(name: string) {
		this.items = this.computeItems();
		const idx = this.items.findIndex((c) => c.name === name);
		if (idx >= 0) this.selected = idx;
		else this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
	}

	handleInput(data: string) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.onClose?.();
			return;
		}
		if (matchesKey(data, Key.shift("up")) || matchesKey(data, Key.shift("down"))) {
			const cur = this.items[this.selected];
			if (cur && this.favs.has(cur.name) && !this.filter.trim()) {
				const delta = matchesKey(data, Key.shift("up")) ? -1 : 1;
				if (this.favs.move(cur.name, delta)) {
					this.rebuildKeepingSelection(cur.name);
				}
			}
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selected > 0) this.selected--;
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.selected < this.items.length - 1) this.selected++;
			this.invalidate();
			return;
		}
		if (data === " ") {
			const cur = this.items[this.selected];
			if (cur) {
				this.favs.toggle(cur.name);
				this.rebuildKeepingSelection(cur.name);
			}
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.filter = this.filter.slice(0, -1);
			this.items = this.computeItems();
			this.selected = 0;
			this.scroll = 0;
			this.invalidate();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.filter += data;
			this.items = this.computeItems();
			this.selected = 0;
			this.scroll = 0;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		const termRows = process.stdout.rows ?? 30;
		const totalHeight = Math.max(14, Math.min(termRows - 4, Math.floor(termRows * 0.7)));
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedHeight === totalHeight
		) {
			return this.cachedLines;
		}

		const innerW = width - 2;
		const border = (s: string) => fg(C.mauve, s);
		const top = border(`╭${"─".repeat(innerW)}╮`);
		const bot = border(`╰${"─".repeat(innerW)}╯`);
		const rule = border("├") + fg(C.surface1, "─".repeat(innerW)) + border("┤");
		const V = border("│");

		const title = bold(fg(C.mauve, " ★ Slash Favorites "));
		const total = this.allCommands.length;
		const starred = this.favs.list().filter((n) => this.allCommands.some((c) => c.name === n))
			.length;
		const hint = fg(C.overlay1, ` ${starred}/${total} starred`);
		const header = `${V}${padTo(innerW, title + hint)}${V}`;

		const filterLine = ` ${fg(C.peach, "/")} ${fg(C.text, this.filter)}${fg(C.peach, "▏")}${fg(
			C.overlay0,
			"  type to filter",
		)}`;
		const filterRow = `${V}${padTo(innerW, filterLine)}${V}`;

		const headerH = 1;
		const filterH = 1;
		const footerH = 1;
		const dividerH = 3;
		const bodyH = Math.max(3, totalHeight - 2 - headerH - filterH - footerH - dividerH);

		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + bodyH) this.scroll = this.selected - bodyH + 1;

		const body: string[] = [];
		const lastFavIdx =
			[...this.items].map((c) => this.favs.has(c.name)).lastIndexOf(true);
		for (let i = 0; i < bodyH; i++) {
			const idx = this.scroll + i;
			const c = this.items[idx];
			if (!c) {
				body.push(`${V}${padTo(innerW, "")}${V}`);
				continue;
			}
			const isSel = idx === this.selected;
			const isFav = this.favs.has(c.name);
			const star = isFav ? fg(C.yellow, "★") : fg(C.overlay0, "☆");
			const rank = isFav ? fg(C.overlay0, padTo(2, String(this.favs.indexOf(c.name) + 1))) : "  ";
			const name = fg(isSel ? C.text : C.subtext0, `/${c.name}`);
			const desc = c.description ? `  ${fg(C.overlay0, c.description)}` : "";
			const prefix = isSel ? fg(C.peach, "▌") : " ";
			const line = `${prefix} ${rank} ${star}  ${bold(name)}${desc}`;
			const truncated = truncateToWidth(line, innerW, "…");
			const colored = isSel ? bg(C.surface0, padTo(innerW, truncated)) : padTo(innerW, truncated);
			body.push(`${V}${colored}${V}`);
			if (
				!this.filter.trim() &&
				idx === lastFavIdx &&
				idx + 1 < this.items.length &&
				body.length < bodyH
			) {
				const sep = fg(C.surface1, "  " + "─".repeat(Math.max(0, innerW - 4)));
				body.push(`${V}${padTo(innerW, sep)}${V}`);
				i++;
			}
		}
		if (this.items.length === 0) {
			body[0] = `${V}${padTo(innerW, `  ${fg(C.overlay1, "No matching commands.")}`)}${V}`;
		}

		const segs: [string, string][] = [
			["↑↓", "navigate"],
			["space", "toggle ★"],
			["⇧↑↓", "reorder ★"],
			["⏎/esc", "save & close"],
		];
		const footerText =
			" " +
			segs
				.map(([k, v]) => `${fg(C.peach, k)} ${fg(C.subtext0, v)}`)
				.join(fg(C.overlay0, "  ·  "));
		const footer = `${V}${padTo(innerW, footerText)}${V}`;

		const lines = [top, header, rule, filterRow, rule, ...body, rule, footer, bot];
		const tinted = lines.map((ln) => bg(C.mantle, padTo(width, ln)));
		this.cachedLines = tinted;
		this.cachedWidth = width;
		this.cachedHeight = totalHeight;
		return tinted;
	}
}

// ─── Entry ───────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	const favs = new FavStore(loadOrder());
	patchAutocomplete(favs);

	pi.registerCommand("favorites", {
		description: "Star/unstar slash commands so favorites appear first when you type /",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/favorites requires an interactive UI", "error");
				return;
			}
			// Guard: patch should already be applied at module load, but if pi
			// hot-reloaded the module the closure may have changed — re-apply.
			patchAutocomplete(favs);

			const all = getAllCommands(pi);
			await ctx.ui.custom<void>(
				(tui, _theme, _kb, done) => {
					const picker = new FavoritesPicker(all, favs);
					picker.onClose = () => done(undefined);
					return {
						render: (w) => picker.render(w),
						invalidate: () => picker.invalidate(),
						handleInput: (data) => {
							picker.handleInput(data);
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						width: "70%",
						minWidth: 60,
						maxHeight: "75%",
						anchor: "center",
					},
				},
			);

			favs.save();
			const starred = favs.list().filter((n) => all.some((c) => c.name === n)).length;
			ctx.ui.notify(`Saved ${starred} favorite${starred === 1 ? "" : "s"}.`, "info");
		},
	});
}
