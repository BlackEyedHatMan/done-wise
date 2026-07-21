import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

// Persists the board to ~/.local/state/done-wise/board.json (NOT GSettings:
// task edits would dirty dconf constantly). All file IO is asynchronous —
// synchronous IO in shell code stalls the compositor. Saves are debounced so
// a burst of quick ticks costs one write; disable() calls flush().

const SAVE_DEBOUNCE_MS = 1000;

export class Store {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'done-wise']);
        this._path = GLib.build_filenamev([this._dir, 'board.json']);
        this._dirEnsured = false;
        this._debounceId = null;
        this._pending = null;
    }

    /** @returns {Promise<?object>} decoded board JSON, or null (first run / unreadable) */
    async load() {
        try {
            const file = Gio.File.new_for_path(this._path);
            const [bytes] = await file.load_contents_async(null);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)))
                console.warn(`[done-wise] could not load board: ${e.message}`);
            return null;
        }
    }

    /** Debounced save; the latest data wins. */
    save(data) {
        this._pending = data;
        if (this._debounceId !== null)
            return;
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Cancel the debounce and write immediately (async). Call from disable(). */
    flush() {
        if (this._debounceId !== null) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        this._write();
    }

    _write() {
        if (this._pending === null)
            return;
        const data = this._pending;
        this._pending = null;
        try {
            if (!this._dirEnsured) {
                GLib.mkdir_with_parents(this._dir, 0o700);
                this._dirEnsured = true;
            }
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(data)));
            const file = Gio.File.new_for_path(this._path);
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null)
                .catch(e => console.warn(`[done-wise] could not save board: ${e.message}`));
        } catch (e) {
            console.warn(`[done-wise] could not save board: ${e.message}`);
        }
    }
}
