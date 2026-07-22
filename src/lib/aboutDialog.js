import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const REPO_URL = 'https://github.com/BlackEyedHatMan/done-wise';
const FOSS_LINE = 'Free and open source';
const LICENSE_LINE = 'MIT License — © 2026 Black Eyed Hat Man';

function caption(text, iconName = null) {
    const row = new St.BoxLayout({
        style: 'spacing: 6px; margin-top: 6px;',
        x_align: Clutter.ActorAlign.CENTER,
    });
    if (iconName) {
        row.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    row.add_child(new St.Label({
        text,
        style: 'font-weight: bold; font-size: 10.5pt;',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    return row;
}

function linkButton(dialog, url) {
    const button = new St.Button({
        label: url,
        style: 'color: #62a0ea; font-size: 10.5pt; padding: 2px 8px;',
        x_align: Clutter.ActorAlign.CENTER,
        can_focus: true,
        track_hover: true,
    });
    button.connect('clicked', () => {
        Gio.AppInfo.launch_default_for_uri(url, null);
        dialog.close();
    });
    return button;
}

/** @param {Extension} extension the DoneWise extension instance */
export function showAboutDialog(extension) {
    const dialog = new ModalDialog.ModalDialog({styleClass: 'done-wise-about-dialog'});

    const content = new St.BoxLayout({
        vertical: true,
        style: 'spacing: 8px; padding: 12px 30px; max-width: 420px;',
        x_align: Clutter.ActorAlign.CENTER,
    });

    content.add_child(new St.Icon({
        gicon: Gio.icon_new_for_string(GLib.build_filenamev(
            [extension.path, 'icons', 'done-wise-robot.png'])),
        icon_size: 96,
        x_align: Clutter.ActorAlign.CENTER,
    }));

    const version = extension.metadata['version-name'] ?? '';
    content.add_child(new St.Label({
        text: `DoneWise ${version}`.trim(),
        style: 'font-weight: bold; font-size: 14pt; text-align: center;',
        x_align: Clutter.ActorAlign.CENTER,
    }));

    const description = new St.Label({
        text: 'Intelligent task prioritization for a calmer, more focused day — ' +
            'your todos in the top bar, grouped and prioritized by you or your AI agent.',
        style: 'text-align: center;',
        x_align: Clutter.ActorAlign.CENTER,
    });
    description.clutter_text.line_wrap = true;
    content.add_child(description);

    content.add_child(caption('Star the repo', 'starred-symbolic'));
    content.add_child(linkButton(dialog, REPO_URL));

    content.add_child(new St.Label({
        text: FOSS_LINE,
        style: 'font-weight: bold; font-size: 9.5pt; text-align: center; margin-top: 10px;',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    content.add_child(new St.Label({
        text: LICENSE_LINE,
        style: 'font-size: 9pt; text-align: center;',
        opacity: 150,
        x_align: Clutter.ActorAlign.CENTER,
    }));

    dialog.contentLayout.add_child(content);
    dialog.addButton({
        label: 'Close',
        action: () => dialog.close(),
        key: Clutter.KEY_Escape,
        default: true,
    });
    dialog.open();
    return dialog;
}
