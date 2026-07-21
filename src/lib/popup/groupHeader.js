import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {INBOX_COLOR, PRIORITY_COLORS, PRIORITY_CYCLE} from '../constants.js';

// Group section header: ▌accent bar (priority colour), bold name, open-task
// count. Local (user-created) groups additionally get an inline edit strip —
// rename, priority cycle, reorder, delete. Provider-owned groups render
// header-only: their structure belongs to the agent.

export const GroupHeader = GObject.registerClass(
class DoneWiseGroupHeader extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {object} params
     * @param {?object} params.group board group, or null for the Inbox
     * @param {number} params.count open tasks in the group
     * @param {?object} params.actions {onRename, onCyclePriority, onMoveGroup, onDelete}
     *   — null for non-editable headers (Inbox, provider groups)
     * @param {(entry: St.Entry) => void} params.grabFocus focus helper from the indicator
     */
    _init({group, count, actions, grabFocus}) {
        super._init({reactive: false, can_focus: false});
        this._group = group;
        this._actions = actions;
        this._grabFocus = grabFocus;
        this._strip = null;

        this._column = new St.BoxLayout({vertical: true, x_expand: true});
        this.add_child(this._column);

        const line = new St.BoxLayout({x_expand: true});
        this._column.add_child(line);

        const color = group ? PRIORITY_COLORS[group.priority] : INBOX_COLOR;
        // St's CSS subset has no reliable border-left — a real child widget is
        // the robust accent bar.
        line.add_child(new St.Widget({
            style: `background-color: ${color}; width: 4px; border-radius: 2px; margin-right: 8px;`,
            y_expand: true,
        }));

        line.add_child(new St.Label({
            text: group ? group.name : 'Inbox',
            style_class: 'done-wise-group-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        line.add_child(new St.Label({
            text: `${count}`,
            style_class: 'done-wise-count-badge',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        if (actions) {
            const editButton = new St.Button({
                style_class: 'icon-button',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-left: 6px;',
                child: new St.Icon({icon_name: 'document-edit-symbolic', icon_size: 12}),
            });
            editButton.connect('clicked', () => this._toggleStrip());
            line.add_child(editButton);
        }
    }

    _toggleStrip() {
        if (this._strip) {
            this._strip.destroy();
            this._strip = null;
            return;
        }
        this._strip = new St.BoxLayout({
            style_class: 'done-wise-action-strip',
            x_expand: true,
            style: 'margin-top: 4px;',
        });

        const rename = new St.Entry({
            text: this._group.name,
            x_expand: true,
        });
        rename.clutter_text.connect('activate', () => {
            this._actions.onRename(this._group.id, rename.get_text());
        });
        this._strip.add_child(rename);

        const nextPriority = PRIORITY_CYCLE[
            (PRIORITY_CYCLE.indexOf(this._group.priority) + 1) % PRIORITY_CYCLE.length];
        this._addStripButton('◉', `Priority: ${this._group.priority} → ${nextPriority}`,
            () => this._actions.onCyclePriority(this._group.id),
            `color: ${PRIORITY_COLORS[this._group.priority]};`);
        this._addStripButton('▲', 'Move group up', () => this._actions.onMoveGroup(this._group.id, -1));
        this._addStripButton('▼', 'Move group down', () => this._actions.onMoveGroup(this._group.id, 1));
        this._addStripButton('Delete', 'Delete group (tasks return to Inbox)',
            () => this._actions.onDelete(this._group.id));

        this._column.add_child(this._strip);
        this._grabFocus?.(rename);
    }

    _addStripButton(label, accessibleName, callback, extraStyle = '') {
        const button = new St.Button({
            can_focus: true,
            accessible_name: accessibleName,
            child: new St.Label({text: label, style: extraStyle}),
        });
        button.connect('clicked', callback);
        this._strip.add_child(button);
    }
});

/** "＋ New group" footer: activating swaps the label for an inline entry. */
export const NewGroupItem = GObject.registerClass(
class DoneWiseNewGroupItem extends PopupMenu.PopupBaseMenuItem {
    _init({onCreate, grabFocus}) {
        super._init({});
        this._onCreate = onCreate;
        this._grabFocus = grabFocus;
        this._entry = null;
        this._label = new St.Label({
            text: '＋ New group',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);
    }

    /** No super.activate() — swapping in the entry must not close the menu. */
    activate(_event) {
        if (this._entry)
            return;
        this._label.hide();
        this._entry = new St.Entry({hint_text: 'Group name…', x_expand: true});
        this._entry.clutter_text.connect('activate', () => {
            const name = this._entry.get_text();
            if (name.trim() !== '')
                this._onCreate(name);
            // The board rebuild that follows replaces this item entirely.
        });
        this.add_child(this._entry);
        this._grabFocus?.(this._entry);
    }
});
