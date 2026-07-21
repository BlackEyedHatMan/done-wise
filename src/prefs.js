import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildGeneralPage} from './prefsPages/generalPage.js';

export default class DoneWisePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(buildGeneralPage(settings));
    }
}
