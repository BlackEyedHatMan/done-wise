import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// One task row: [☐ title …………… ⋯]. Clicking the row toggles done-state; the
// trailing "⋯" expands an inline action strip (move to group, reorder,
// delete) inside the row, so no interaction ever closes the menu.

export const TaskRow = GObject.registerClass(
class DoneWiseTaskRow extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {object} params
     * @param {object} params.task board task
     * @param {Array<{id: ?string, name: string}>} params.moveTargets other groups (id null = Inbox)
     * @param {object} params.actions {onToggle, onMove, onReorder, onDelete}
     */
    _init({task, moveTargets, actions}) {
        super._init({style_class: 'done-wise-task-row'});
        this._task = task;
        this._moveTargets = moveTargets;
        this._actions = actions;
        this._strip = null;

        // Vertical box: main line + (lazily) the action strip.
        this._column = new St.BoxLayout({vertical: true, x_expand: true});
        this.add_child(this._column);

        const line = new St.BoxLayout({x_expand: true});
        this._column.add_child(line);

        this._checkbox = new St.Icon({
            icon_size: 16,
            style: 'margin-right: 8px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        line.add_child(this._checkbox);

        this._label = new St.Label({
            text: task.title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.set_ellipsize(3); // Pango.EllipsizeMode.END
        line.add_child(this._label);

        this._moreButton = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'view-more-symbolic', icon_size: 14}),
        });
        this._moreButton.connect('clicked', () => this._toggleStrip());
        line.add_child(this._moreButton);

        this._applyDoneStyle();
    }

    /**
     * Deliberately does NOT chain to super.activate(): the base implementation
     * emits 'activate', which the menu answers by closing. A checkbox click
     * must keep the popup open.
     *
     * The row never mutates the task itself — this._task is the model's own
     * object, and pre-flipping `done` here made Board.setDone() see a no-op
     * (so no dirty flag, no queued PATCH, and the next pull reverted the
     * tick). Ask the model first, then restyle from its updated state.
     */
    activate(_event) {
        this._actions.onToggle(this._task.id, !this._task.done);
        this._applyDoneStyle();
    }

    _applyDoneStyle() {
        const done = this._task.done;
        this._checkbox.icon_name = done ? 'checkbox-checked-symbolic' : 'checkbox-symbolic';
        this._label.opacity = done ? 140 : 255;
        if (done)
            this._label.add_style_class_name('done-wise-task-done');
        else
            this._label.remove_style_class_name('done-wise-task-done');
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
        for (const target of this._moveTargets) {
            if (target.id === this._task.groupId)
                continue;
            this._addStripButton(`→ ${target.name}`,
                () => this._actions.onMove(this._task.id, target.id));
        }
        if (!this._task.done) {
            this._addStripButton('▲', () => this._actions.onReorder(this._task.id, -1));
            this._addStripButton('▼', () => this._actions.onReorder(this._task.id, 1));
        }
        this._addStripButton('Delete', () => this._actions.onDelete(this._task.id));
        this._column.add_child(this._strip);
    }

    _addStripButton(label, callback) {
        const button = new St.Button({
            can_focus: true,
            child: new St.Label({text: label}),
        });
        button.connect('clicked', callback);
        this._strip.add_child(button);
    }
});
