// Login window. All work happens in the shell extension; this only talks to
// it over D-Bus (see lib/dbus.js).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DBUS_IFACE, DBUS_NAME, DBUS_PATH, DBUS_XML} from './lib/dbus.js';

function fmt(str, ...args) {
    return str.replace(/%s/g, () => args.shift());
}

function hero(iconName, title, description) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    box.append(new Gtk.Image({
        icon_name: iconName,
        pixel_size: 80,
        css_classes: ['dim-label'],
        margin_bottom: 12,
    }));
    const titleLabel = new Gtk.Label({
        label: title,
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ['title-1'],
    });
    box.append(titleLabel);
    const descLabel = new Gtk.Label({
        label: description,
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ['dim-label'],
    });
    box.append(descLabel);
    return {box, titleLabel, descLabel};
}

function pill(label, suggested = false) {
    return new Gtk.Button({
        label,
        halign: Gtk.Align.CENTER,
        css_classes: suggested ? ['pill', 'suggested-action'] : ['pill'],
    });
}

export default class ProtonBridgePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        window.set_default_size(420, 600);
        window.title = _('Proton Mail');
        window.search_enabled = false;

        const app = Gio.AppInfo.get_default_for_uri_scheme('mailto');
        this._mailApp = app;
        this._mailAppName = app?.get_display_name() ?? _('your mail app');

        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            vhomogeneous: false,
            margin_top: 24,
            margin_bottom: 24,
        });
        this._pages = {};
        this._buildPages();

        const group = new Adw.PreferencesGroup();
        group.add(this._stack);
        const page = new Adw.PreferencesPage();
        page.add(group);
        window.add(page);

        this._proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            Gio.DBusNodeInfo.new_for_xml(DBUS_XML).interfaces[0],
            DBUS_NAME, DBUS_PATH, DBUS_IFACE, null);
        const id = this._proxy.connect('g-properties-changed', () => this._sync());
        window.connect('close-request', () => this._proxy.disconnect(id));
        this._sync();
    }

    _prop(name) {
        return this._proxy.get_cached_property(name)?.unpack() ?? '';
    }

    _call(method, args = null) {
        this._proxy.call(method, args, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                Gio.DBusError.strip_remote_error(e);
                this._showError(e.message);
            }
        });
    }

    // ---- pages ----------------------------------------------------------

    _addPage(name, {icon, title, description, rows = [], buttons = []}) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 24,
            valign: Gtk.Align.CENTER,
        });
        const header = hero(icon, title, description);
        box.append(header.box);

        let list = null;
        if (rows.length) {
            list = new Gtk.ListBox({
                selection_mode: Gtk.SelectionMode.NONE,
                css_classes: ['boxed-list'],
            });
            rows.forEach(row => list.append(row));
            box.append(list);
        }

        const error = new Gtk.Label({
            wrap: true,
            justify: Gtk.Justification.CENTER,
            css_classes: ['error'],
            visible: false,
        });
        box.append(error);

        const actions = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
        });
        buttons.forEach(b => actions.append(b));
        box.append(actions);

        this._stack.add_named(box, name);
        this._pages[name] = {box, header, list, error, buttons, rows};
        return this._pages[name];
    }

    _buildPages() {
        const spinner = new Adw.Spinner({width_request: 48, height_request: 48, halign: Gtk.Align.CENTER});
        const starting = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, valign: Gtk.Align.CENTER});
        starting.append(spinner);
        starting.append(new Gtk.Label({label: _('Starting Proton Mail Bridge…'), css_classes: ['dim-label']}));
        this._stack.add_named(starting, 'starting');

        this._addPage('unavailable', {
            icon: 'application-x-addon-symbolic',
            title: _('Extension Is Off'),
            description: _('Turn on the Proton Mail Bridge extension, then reopen this window.'),
        });

        const retry = pill(_('Try Again'), true);
        retry.connect('clicked', () => this._call('Retry'));
        this._addPage('failed', {
            icon: 'dialog-error-symbolic',
            title: _('Bridge Couldn’t Start'),
            description: '',
            buttons: [retry],
        });

        // Sign in
        this._email = new Adw.EntryRow({title: _('Email'), input_purpose: Gtk.InputPurpose.EMAIL});
        this._password = new Adw.PasswordEntryRow({title: _('Password')});
        const signIn = pill(_('Sign In'), true);
        const submitLogin = () => {
            if (!this._email.text.trim() || !this._password.text)
                return;
            this._call('Login', new GLib.Variant('(ss)', [this._email.text.trim(), this._password.text]));
            this._password.text = '';
        };
        this._email.connect('entry-activated', () => this._password.grab_focus());
        this._password.connect('entry-activated', submitLogin);
        signIn.connect('clicked', submitLogin);
        this._addPage('signed-out', {
            icon: 'mail-unread-symbolic',
            title: _('Sign in to Proton'),
            description: _('You’ll get a password to use in your mail app.'),
            rows: [this._email, this._password],
            buttons: [signIn],
        });

        // Two-factor code
        this._code = new Adw.EntryRow({title: _('Code'), input_purpose: Gtk.InputPurpose.DIGITS});
        const verify = pill(_('Verify'), true);
        const submitCode = () => {
            if (!this._code.text.trim())
                return;
            this._call('SubmitCode', new GLib.Variant('(s)', [this._code.text]));
            this._code.text = '';
        };
        this._code.connect('entry-activated', submitCode);
        verify.connect('clicked', submitCode);
        this._addPage('code', {
            icon: 'security-high-symbolic',
            title: _('Two-Factor Authentication'),
            description: _('Enter the code from your authenticator app.'),
            rows: [this._code],
            buttons: [verify, this._cancelButton()],
        });

        // Mailbox password (accounts in two-password mode)
        this._mailbox = new Adw.PasswordEntryRow({title: _('Mailbox Password')});
        const unlock = pill(_('Unlock'), true);
        const submitMailbox = () => {
            if (!this._mailbox.text)
                return;
            this._call('SubmitMailboxPassword', new GLib.Variant('(s)', [this._mailbox.text]));
            this._mailbox.text = '';
        };
        this._mailbox.connect('entry-activated', submitMailbox);
        unlock.connect('clicked', submitMailbox);
        this._addPage('mailbox-password', {
            icon: 'dialog-password-symbolic',
            title: _('Mailbox Password'),
            description: _('This account uses a separate password to unlock your mailbox.'),
            rows: [this._mailbox],
            buttons: [unlock, this._cancelButton()],
        });

        // Human verification (CAPTCHA) in the browser
        const open = pill(_('Open Browser'), true);
        open.connect('clicked', () => {
            const url = this._prop('VerificationUrl');
            if (url.startsWith('https://'))
                new Gtk.UriLauncher({uri: url}).launch(this._window, null, null);
        });
        const cont = pill(_('Continue'));
        cont.connect('clicked', () => this._call('ContinueVerification'));
        this._addPage('verify', {
            icon: 'web-browser-symbolic',
            title: _('Verify It’s You'),
            description: _('Proton needs a quick check in your browser. Finish it there, then continue.'),
            buttons: [open, cont, this._cancelButton()],
        });

        // Signed in: show the Bridge password to enter in the mail app
        this._creds = {};
        const credRows = [
            ['email', _('Email'), false],
            ['password', _('Bridge Password'), true],
            ['imap', _('IMAP Server'), false],
            ['smtp', _('SMTP Server'), false],
        ].map(([key, title, mono]) => {
            const row = new Adw.ActionRow({title, subtitle_selectable: true, css_classes: ['property']});
            if (mono)
                row.add_css_class('monospace');
            const copy = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Copy'),
                css_classes: ['flat'],
            });
            copy.connect('clicked', () => {
                this._window.get_display().get_clipboard().set(row.subtitle);
            });
            row.add_suffix(copy);
            this._creds[key] = row;
            return row;
        });
        const openApp = pill(fmt(_('Open %s'), this._mailAppName), true);
        openApp.sensitive = !!this._mailApp;
        openApp.connect('clicked', () =>
            this._mailApp?.launch([], this._window.get_display().get_app_launch_context()));
        const signOut = new Gtk.Button({
            label: _('Sign Out'),
            halign: Gtk.Align.CENTER,
            css_classes: ['flat', 'error'],
        });
        signOut.connect('clicked', () => this._confirmSignOut());
        this._addPage('signed-in', {
            icon: 'object-select-symbolic',
            title: '',
            description: fmt(_('Enter this password when %s asks you to sign in. It’s not your Proton password.'), this._mailAppName),
            rows: credRows,
            buttons: [openApp, signOut],
        });
    }

    _loadCredentials() {
        this._proxy.call('GetCredentials', null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                const [email, password, imap, smtp] = proxy.call_finish(res).deepUnpack();
                Object.entries({email, password, imap, smtp})
                    .forEach(([key, value]) => (this._creds[key].subtitle = value));
            } catch (e) {
                Gio.DBusError.strip_remote_error(e);
                this._showError(e.message);
            }
        });
    }

    _cancelButton() {
        const button = new Gtk.Button({label: _('Cancel'), halign: Gtk.Align.CENTER, css_classes: ['flat']});
        button.connect('clicked', () => this._call('Cancel'));
        return button;
    }

    _confirmSignOut() {
        const dialog = new Adw.AlertDialog({
            heading: _('Sign Out?'),
            body: _('Your Proton account will be removed from this device. Your mail app will no longer be able to sign in.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('sign-out', _('Sign Out'));
        dialog.set_response_appearance('sign-out', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response === 'sign-out')
                this._call('SignOut');
        });
        dialog.present(this._window);
    }

    // ---- state ----------------------------------------------------------

    _showError(message) {
        const page = this._pages[this._stack.visible_child_name];
        if (!page)
            return;
        page.error.label = message;
        page.error.visible = !!message;
    }

    _setBusy(busy) {
        const page = this._pages[this._stack.visible_child_name];
        if (!page)
            return;
        page.list?.set_sensitive(!busy);
        page.buttons.forEach(b => (b.sensitive = !busy));
        const primary = page.buttons[0];
        if (!primary)
            return;
        if (busy && !primary._label) {
            primary._label = primary.label;
            primary.child = new Adw.Spinner();
        } else if (!busy && primary._label) {
            primary.label = primary._label;
            primary._label = null;
        }
    }

    _sync() {
        const state = this._prop('State') || 'unavailable';
        if (state === 'working') {
            this._setBusy(true);
            return;
        }
        this._setBusy(false);

        const page = state === 'starting' ? null : this._pages[state] ? state : 'unavailable';
        this._stack.visible_child_name = page ?? 'starting';
        const username = this._prop('Username');

        switch (state) {
        case 'signed-out':
            if (!this._email.text && username)
                this._email.text = username;
            (this._email.text ? this._password : this._email).grab_focus();
            break;
        case 'code':
            this._code.grab_focus();
            break;
        case 'mailbox-password':
            this._mailbox.grab_focus();
            break;
        case 'signed-in':
            this._pages['signed-in'].header.titleLabel.label = _('Signed In');
            this._loadCredentials();
            break;
        case 'failed':
            this._pages.failed.header.descLabel.label =
                this._prop('Error') || _('Proton Mail Bridge stopped unexpectedly.');
            return;
        }
        this._showError(this._prop('Error'));
    }
}
