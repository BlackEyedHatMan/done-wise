import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// The quick-add entry lives in a non-reactive, non-focusable menu item so
// hover/keynav never treats it as an activatable row (activation would close
// the menu). Enter adds the task and keeps both the menu and the focus, so
// several tasks can be typed in a row.

export function createQuickAddItem(onSubmit) {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: 'done-wise-quick-add',
    });
    const entry = new St.Entry({
        hint_text: 'Add a task…',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    entry.clutter_text.connect('activate', () => {
        const text = entry.get_text();
        entry.set_text('');
        onSubmit(text);
    });
    item.add_child(entry);
    return {item, entry};
}
