import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

/**
 * @param {Gio.Settings} settings
 * @returns {Adw.PreferencesPage}
 */
export function buildGeneralPage(settings) {
    const page = new Adw.PreferencesPage({
        title: 'General',
        icon_name: 'preferences-system-symbolic',
    });

    // --- AI provider sync ---
    const sync = new Adw.PreferencesGroup({
        title: 'AI Provider Sync',
        description: 'Point DoneWise at any service implementing the DoneWise ' +
            'provider contract and an AI agent can group and prioritise your ' +
            'tasks. Leave the URL empty for standalone use.',
    });

    const url = new Adw.EntryRow({
        title: 'Provider URL',
        show_apply_button: true,
    });
    url.text = settings.get_string('provider-url');
    url.connect('apply', () => settings.set_string('provider-url', url.text.trim()));
    sync.add(url);

    const token = new Adw.PasswordEntryRow({
        title: 'App token',
        show_apply_button: true,
    });
    token.text = settings.get_string('provider-token');
    token.connect('apply', () => settings.set_string('provider-token', token.text.trim()));
    sync.add(token);

    const poll = new Adw.SpinRow({
        title: 'Poll interval',
        subtitle: 'Seconds between provider board checks',
        adjustment: new Gtk.Adjustment({
            lower: 30, upper: 3600, step_increment: 30, page_increment: 300,
        }),
    });
    settings.bind('poll-interval-seconds', poll, 'value', Gio.SettingsBindFlags.DEFAULT);
    sync.add(poll);

    page.add(sync);

    // --- Housekeeping ---
    const housekeeping = new Adw.PreferencesGroup({title: 'Housekeeping'});

    const retention = new Adw.SpinRow({
        title: 'Completed-task retention',
        subtitle: 'Completed tasks are removed this many days after their ' +
            'completion has been synced (or completed, in standalone use)',
        adjustment: new Gtk.Adjustment({
            lower: 1, upper: 90, step_increment: 1, page_increment: 7,
        }),
    });
    settings.bind('retention-days', retention, 'value', Gio.SettingsBindFlags.DEFAULT);
    housekeeping.add(retention);

    page.add(housekeeping);

    return page;
}
