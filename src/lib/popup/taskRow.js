import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const STAR_COLOR = '#f5c211';

// The row whose drop indicator is currently showing; DND gives targets no
// "drag left" event, so the next hovered row clears the previous one.
let currentDropRow = null;

function clearDropIndicator() {
    currentDropRow?._clearDropIndicator();
    currentDropRow = null;
}

// One task row: [☆ ☐ title …………… ⋯]. Clicking the row toggles done-state;
// the star (shown on hover, or always while starred) pins the task to the
// Starred section; rows are draggable to reorder within their group; the
// trailing "⋯" expands an inline action strip. No interaction closes the menu.

export const TaskRow = GObject.registerClass(
class DoneWiseTaskRow extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {object} params
     * @param {object} params.task board task
     * @param {Array<{id: ?string, name: string}>} params.moveTargets other groups (id null = Inbox)
     * @param {object} params.actions {onToggle, onToggleStar, onMove, onReorderDrop,
     *   onDelete, onRename, grabFocus, autoscroll, starLimitReached}
     * @param {boolean} params.draggable reorderable by drag (open, unstarred rows)
     */
    _init({task, moveTargets, actions, draggable}) {
        super._init({style_class: 'done-wise-task-row'});
        this._task = task;
        this._moveTargets = moveTargets;
        this._actions = actions;
        this._strip = null;
        this._editEntry = null;
        this._isDoneWiseTaskRow = true;

        // Vertical box: main line + (lazily) the action strip.
        this._column = new St.BoxLayout({vertical: true, x_expand: true});
        this.add_child(this._column);

        const line = new St.BoxLayout({x_expand: true});
        this._column.add_child(line);

        this._starButton = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            accessible_name: task.starred ? 'Unstar task' : 'Star task',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_size: 14}),
        });
        this._starButton.connect('clicked', () => this._actions.onToggleStar(this._task.id));
        line.add_child(this._starButton);

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
        this._applyStarStyle();
        this.connect('notify::hover', () => this._applyStarStyle());

        if (draggable && !task.done)
            this._setupDrag();
    }

    /**
     * Deliberately does NOT chain to super.activate(): the base implementation
     * emits 'activate', which the menu answers by closing. A checkbox click
     * must keep the popup open.
     *
     * The row never mutates the task itself — this._task is the model's own
     * object; ask the model first, then restyle from its updated state.
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

    /** Star: yellow while starred; grey outline on hover; hidden otherwise. */
    _applyStarStyle() {
        const starred = this._task.starred;
        const icon = this._starButton.child;
        this._starButton.visible = starred || (this.hover && !this._task.done);
        icon.icon_name = starred ? 'starred-symbolic' : 'non-starred-symbolic';
        icon.style = starred ? `color: ${STAR_COLOR};` : 'opacity: 0.6;';
        this._starButton.accessible_name = starred ? 'Unstar task' : 'Star task';
    }

    // ---- drag-and-drop (reorder within the group) ----

    _setupDrag() {
        this._delegate = this; // target discovery walks parents for _delegate
        this._draggable = DND.makeDraggable(this, {
            timeoutThreshold: 200,
            dragActorOpacity: 210,
        });
        // The row's own click gesture must not cancel a recognized drag and
        // close the menu on release (windowPreview.js:126 pattern).
        if (this._clickGesture?.can_not_cancel && this._draggable.startGesture)
            this._clickGesture.can_not_cancel(this._draggable.startGesture);
        this._draggable.connect('drag-begin', () => {
            this.add_style_class_name('done-wise-dragging');
        });
        for (const signal of ['drag-end', 'drag-cancelled']) {
            this._draggable.connect(signal, () => {
                this.remove_style_class_name('done-wise-dragging');
                clearDropIndicator();
            });
        }
    }

    /** Floating clone — the real row must stay put (BoxPointer re-layouts otherwise). */
    getDragActor() {
        const clone = new St.BoxLayout({
            style_class: 'done-wise-drag-clone',
            width: this.width,
        });
        clone.add_child(new St.Label({
            text: this._task.title,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return clone;
    }

    getDragActorSource() {
        return this;
    }

    _dropAcceptable(source) {
        return source?._isDoneWiseTaskRow === true &&
            source !== this &&
            !source._task.done && !this._task.done &&
            !source._task.starred && !this._task.starred &&
            source._task.groupId === this._task.groupId;
    }

    handleDragOver(source, _actor, _x, y, _time) {
        this._actions.autoscroll?.();
        if (!this._dropAcceptable(source))
            return DND.DragMotionResult.NO_DROP;
        if (currentDropRow !== this) {
            currentDropRow?._clearDropIndicator();
            currentDropRow = this;
        }
        this._dropAbove = y < this.height / 2;
        this.remove_style_class_name(this._dropAbove ? 'done-wise-drop-below' : 'done-wise-drop-above');
        this.add_style_class_name(this._dropAbove ? 'done-wise-drop-above' : 'done-wise-drop-below');
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _actor, _x, _y, _time) {
        clearDropIndicator();
        if (!this._dropAcceptable(source))
            return false;
        this._actions.onReorderDrop(source._task.id, this._task.id, this._dropAbove);
        return true;
    }

    _clearDropIndicator() {
        this.remove_style_class_name('done-wise-drop-above');
        this.remove_style_class_name('done-wise-drop-below');
    }

    // ---- inline action strip ----

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
        this._addStripButton('Edit', () => this._startEdit());
        for (const target of this._moveTargets) {
            if (target.id === this._task.groupId)
                continue;
            this._addStripButton(`→ ${target.name}`,
                () => this._actions.onMove(this._task.id, target.id));
        }
        this._addStripButton('Delete', () => this._actions.onDelete(this._task.id));
        this._column.add_child(this._strip);
    }

    /** Swap the label for an entry; Enter commits the rename. */
    _startEdit() {
        if (this._editEntry)
            return;
        this._editEntry = new St.Entry({text: this._task.title, x_expand: true});
        this._editEntry.clutter_text.connect('activate', () => {
            // The rename triggers a structural rebuild that replaces this row.
            this._actions.onRename(this._task.id, this._editEntry.get_text());
        });
        this._label.hide();
        this._label.get_parent().insert_child_above(this._editEntry, this._label);
        this._actions.grabFocus(this._editEntry);
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
