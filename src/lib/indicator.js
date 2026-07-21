import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {IndicatorState} from './constants.js';
import {SyncState} from './syncEngine.js';
import {BoardMenu} from './boardMenu.js';
import {createQuickAddItem} from './quickAdd.js';
import {NewGroupItem} from './groupHeader.js';

const SYNC_DOT_COLORS = {
    [SyncState.OK]: '#26a269',
    [SyncState.ERROR]: '#e5a50a',
    [SyncState.AUTH_ERROR]: '#e01b24',
};

export const Indicator = GObject.registerClass(
class DoneWiseIndicator extends PanelMenu.Button {
    /**
     * @param {object} params
     * @param {Extension} params.extension
     * @param {Board} params.board
     * @param {object} params.actions handlers from extension.js
     */
    _init({extension, board, actions}) {
        super._init(0.5, 'DoneWise');
        this._extension = extension;
        this._board = board;
        this._actions = actions;
        this._idleIds = new Set();

        this._gicons = {};
        for (const state of Object.values(IndicatorState)) {
            this._gicons[state] = Gio.icon_new_for_string(GLib.build_filenamev(
                [extension.path, 'icons', `done-wise-${state}-symbolic.svg`]));
        }
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._icon);
        this._state = null;
        this.setState(IndicatorState.NORMAL);

        this._buildMenu();

        this._openStateId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                return;
            const workArea = Main.layoutManager.primaryMonitor?.workArea ??
                {height: 900};
            this._scroll.style = `max-height: ${Math.floor(workArea.height * 0.6)}px;`;
            this._grabFocus(this._quickAddEntry);
        });
    }

    _buildMenu() {
        // Header: DoneWise · sync dot · gear.
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.add_child(new St.Label({
            text: 'DoneWise',
            style_class: 'done-wise-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._syncDot = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            accessible_name: 'Sync now',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Label({text: '●'}),
            visible: false,
        });
        this._syncDot.connect('clicked', () => this._actions.onSyncNow());
        header.add_child(this._syncDot);

        const gear = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            accessible_name: 'DoneWise preferences',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 16}),
        });
        gear.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        header.add_child(gear);
        this.menu.addMenuItem(header);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const {item: quickAddItem, entry} = createQuickAddItem(
            title => this._actions.onAddTask(title));
        this._quickAddEntry = entry;
        this.menu.addMenuItem(quickAddItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Scrollable board area. GNOME 46+: St.ScrollView.child (add_actor is gone).
        this._boardMenu = new BoardMenu({
            actions: this._actions,
            grabFocus: e => this._grabFocus(e),
        });
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._scroll.child = this._boardMenu.section.actor;
        const wrapper = new PopupMenu.PopupMenuSection();
        wrapper.actor.add_child(this._scroll);
        this.menu.addMenuItem(wrapper);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addMenuItem(new NewGroupItem({
            onCreate: name => this._actions.onAddGroup(name),
            grabFocus: e => this._grabFocus(e),
        }));

        this.rebuild();
    }

    /** Rebuild the board area from the model (structural changes). */
    rebuild() {
        // Preserve scroll position across the rebuild.
        const position = this._scroll.vadjustment?.value ?? 0;
        this._boardMenu.rebuild(this._board);
        const idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleIds.delete(idle);
            if (this._scroll.vadjustment)
                this._scroll.vadjustment.value = position;
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(idle);
    }

    /**
     * Popup menus hold the input grab, so an entry never receives focus by
     * itself — and the menu's own focus setup finishes after the open signal,
     * hence the idle deferral.
     */
    _grabFocus(entry) {
        const idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleIds.delete(idle);
            global.stage.set_key_focus(entry.clutter_text);
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(idle);
    }

    /** @param {string} state one of IndicatorState */
    setState(state) {
        if (state === this._state)
            return;
        this._state = state;
        this._icon.gicon = this._gicons[state] ?? this._gicons[IndicatorState.NORMAL];
    }

    /** @param {string} syncState one of SyncState ('idle' hides the dot) */
    setSyncState(syncState, lastError) {
        const visible = syncState !== SyncState.IDLE;
        this._syncDot.visible = visible;
        if (!visible)
            return;
        this._syncDot.child.style = `color: ${SYNC_DOT_COLORS[syncState] ?? '#9a9996'};`;
        this._syncDot.accessible_name = lastError
            ? `Sync now (last error: ${lastError})`
            : 'Sync now';
    }

    destroy() {
        if (this._openStateId) {
            this.menu.disconnect(this._openStateId);
            this._openStateId = null;
        }
        for (const id of this._idleIds)
            GLib.source_remove(id);
        this._idleIds.clear();
        super.destroy();
    }
});
