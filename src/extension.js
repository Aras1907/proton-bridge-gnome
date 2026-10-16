// Proton Mail Bridge for GNOME: runs Bridge in the background, signs in
// through its gRPC API and then shows the Bridge-generated mailbox password,
// which the user enters in their mail app. There is no top bar UI; sign-in
// happens in the preferences window.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {BridgeProcess, BridgeState, bundledBridge} from './lib/bridge.js';
import {DBUS_PATH, DBUS_XML} from './lib/dbus.js';
import {BridgeClient, Writer, pb, stringValue} from './lib/grpc.js';

const CONFIG_FILE = GLib.build_filenamev([GLib.get_user_config_dir(),
    'protonmail', 'bridge-v3', 'grpcServerConfig.json']);
const CONFIG_WAIT = 120;            // × 500 ms
const UserState = {SIGNED_OUT: 0, LOCKED: 1, CONNECTED: 2};
const LoginEvent = {
    ERROR: 1, TFA: 2, TWO_PASSWORDS: 3, FINISHED: 4, ALREADY_LOGGED_IN: 5,
    HV: 6, FIDO: 7, TFA_OR_FIDO: 8,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function loginRequest(username, secret, useHv = false) {
    // Bridge expects secrets base64-encoded inside the bytes field.
    return new Writer()
        .string(1, username)
        .bytes(2, encoder.encode(GLib.base64_encode(encoder.encode(secret))))
        .bool(3, useHv)
        .finish();
}

function parseUser(m) {
    return {
        id: pb.str(m, 1),
        username: pb.str(m, 2),
        state: pb.int(m, 4),
        password: pb.raw(m, 8),
        addresses: pb.strs(m, 9),
    };
}

function loginError(type, message) {
    switch (type) {
    case 0: return message || _('Incorrect email or password.');
    case 1: return _('Proton Mail Bridge needs a paid Proton plan.');
    case 2: return _('Can’t reach Proton. Check your internet connection.');
    case 3: return _('Incorrect code. Try again.');
    case 5: return _('Incorrect mailbox password.');
    case 7: return message || _('Verification failed. Try again.');
    case 8: case 9: case 10:
        return _('This account needs a security key, which isn’t supported here.');
    default: return message || _('Sign-in was interrupted. Try again.');
    }
}

export default class ProtonBridgeExtension extends Extension {
    enable() {
        this._state = 'starting';
        this._error = '';
        this._username = '';
        this._url = '';
        this._gen = 0;

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, this._dbusApi());
        this._dbus.export(Gio.DBus.session, DBUS_PATH);

        this._bridge = new BridgeProcess(state => this._onBridgeState(state));
        this._start();
    }

    disable() {
        this._disconnect();
        this._bridge.destroy();
        this._dbus.unexport();
        this._source?.destroy();

        this._bridge = null;
        this._dbus = null;
        this._source = null;
        this._login = null;
        this._user = null;
    }

    // ---- D-Bus API for the login window ----------------------------------

    _dbusApi() {
        const self = this;
        const expect = (...states) => {
            if (!states.includes(self._state) || !self._client)
                throw new Error(`Not possible in state ${self._state}`);
        };
        return {
            get State() {
                return self._state;
            },
            get Error() {
                return self._error;
            },
            get Username() {
                return self._username;
            },
            get VerificationUrl() {
                return self._url;
            },
            Login(username, password) {
                expect('signed-out');
                self._login = {username: username.trim(), password};
                self._username = self._login.username;
                self._request('Login', loginRequest(self._login.username, password));
            },
            SubmitCode(code) {
                expect('code');
                self._request('Login2FA', loginRequest(self._login.username, code.replace(/\s/g, '')));
            },
            SubmitMailboxPassword(password) {
                expect('mailbox-password');
                self._request('Login2Passwords', loginRequest(self._login.username, password));
            },
            ContinueVerification() {
                expect('verify');
                self._request('Login', loginRequest(self._login.username, self._login.password, true));
            },
            Cancel() {
                if (self._login && self._client) {
                    self._client.call('LoginAbort', new Writer().string(1, self._login.username).finish())
                        .catch(() => {});
                }
                self._login = null;
                self._setState('signed-out');
            },
            SignOut() {
                expect('signed-in');
                self._signOut().catch(e => self._setState('signed-in', e.message));
            },
            Retry() {
                self._start();
            },
            // Credentials to enter in a mail app: [email, bridge password, IMAP, SMTP].
            GetCredentials() {
                expect('signed-in');
                const s = self._servers;
                return [self._username, decoder.decode(self._user.password),
                    `127.0.0.1:${s.imapPort}`, `127.0.0.1:${s.smtpPort}`];
            },
        };
    }

    _setState(state, error = '') {
        this._state = state;
        this._error = error;
        if (state !== 'verify')
            this._url = '';
        for (const [name, value] of [['State', state], ['Error', error],
            ['Username', this._username], ['VerificationUrl', this._url]])
            this._dbus.emit_property_changed(name, GLib.Variant.new_string(value));
    }

    _request(method, payload) {
        this._setState('working');
        this._client.call(method, payload).catch(e => {
            this._login = null;
            this._setState('signed-out', e.message);
        });
    }

    // ---- Bridge lifecycle -------------------------------------------------

    _start() {
        this._disconnect();
        const path = bundledBridge(this.path);
        if (!path) {
            this._bridge.stop();
            this._setState('failed', _('This copy of the extension is missing Proton Mail Bridge. Reinstall it with “make install”.'));
            return;
        }
        this._removeStaleConfig();
        this._setState('starting');
        this._bridge.start(path);
    }

    _removeStaleConfig() {
        try {
            Gio.File.new_for_path(CONFIG_FILE).delete(null);
        } catch {}
    }

    _onBridgeState(state) {
        switch (state) {
        case BridgeState.RUNNING:
            this._connect().catch(e => {
                console.warn(`Proton Bridge: ${e.message}`);
                this._setState('failed', _('Couldn’t connect to Proton Mail Bridge.'));
            });
            break;
        case BridgeState.RESTARTING:
            this._disconnect();
            this._removeStaleConfig();
            this._setState('starting');
            break;
        case BridgeState.FAILED:
            this._disconnect();
            this._setState('failed', this._bridge.detail);
            break;
        }
    }

    _disconnect() {
        this._gen++;
        this._client?.close();
        this._client = null;
        this._login = null;
    }

    async _waitForConfig(gen) {
        const file = Gio.File.new_for_path(CONFIG_FILE);
        for (let i = 0; i < CONFIG_WAIT; i++) {
            if (file.query_exists(null))
                return file;
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }));
            if (gen !== this._gen)
                return null;
        }
        throw new Error('Bridge did not start its gRPC service');
    }

    async _connect() {
        const gen = ++this._gen;
        const file = await this._waitForConfig(gen);
        if (!file)
            return;
        // Bridge quits when the event stream closes, so whenever the connection
        // drops, the process manager restarts it and we reconnect.
        const client = await BridgeClient.connect(file, error => {
            if (gen === this._gen) {
                console.warn(`Proton Bridge: connection lost: ${error.message}`);
                this._client = null;
            }
        });
        if (gen !== this._gen) {
            client.close();
            return;
        }
        this._client = client;
        client.stream('RunEventStream', new Writer().string(1, 'linux').finish(),
            event => this._onEvent(event).catch(logError)).catch(() => {});
        await this._syncUsers();
    }

    async _syncUsers() {
        if (this._login || !this._client)
            return;
        const users = pb.msgs(await this._client.call('GetUserList'), 1).map(parseUser);
        const user = users.find(u => u.state === UserState.CONNECTED) ?? users[0];
        if (!user) {
            this._user = null;
            this._setState('signed-out');
            return;
        }

        this._username = user.addresses[0] ?? user.username;
        if (user.state === UserState.SIGNED_OUT) {
            this._user = null;
            this._setState('signed-out', _('Your Proton session ended. Sign in again.'));
            this._notifySignIn();
            return;
        }

        this._user = user;
        await this._loadServers();
        this._setState('signed-in');
    }

    async _loadServers() {
        const s = await this._client.call('MailServerSettings');
        this._servers = {imapPort: pb.int(s, 1) || 1143, smtpPort: pb.int(s, 2) || 1025};
    }

    async _onEvent(event) {
        const [kind, body] = pb.oneof(event);
        if (kind === 2) {
            const [type, e] = pb.oneof(body);
            await this._onLoginEvent(type, e);
        } else if (kind === 8) {
            const [type, e] = pb.oneof(body);
            if (type === 2 && this._state === 'signed-in') {     // userDisconnected
                this._username = pb.str(e, 1) || this._username;
                this._user = null;
                this._setState('signed-out', _('Your Proton session ended. Sign in again.'));
                this._notifySignIn();
            } else if (type === 3) {                            // userChanged
                await this._syncUsers();
            }
        }
    }

    async _onLoginEvent(type, e) {
        if (!this._login)
            return;
        switch (type) {
        case LoginEvent.ERROR: {
            const code = pb.int(e, 1);
            const message = loginError(code, pb.str(e, 2));
            if (code === 3)
                this._setState('code', message);
            else if (code === 5)
                this._setState('mailbox-password', message);
            else
                this._abort(message);
            break;
        }
        case LoginEvent.TFA:
        case LoginEvent.TFA_OR_FIDO:
            this._setState('code');
            break;
        case LoginEvent.TWO_PASSWORDS:
            this._setState('mailbox-password');
            break;
        case LoginEvent.HV: {
            const url = pb.str(e, 1);
            if (!url.startsWith('https://')) {
                this._abort(_('Verification failed. Try again.'));
                break;
            }
            this._url = url;
            this._setState('verify');
            break;
        }
        case LoginEvent.FIDO:
            this._abort(loginError(10));
            break;
        case LoginEvent.FINISHED:
        case LoginEvent.ALREADY_LOGGED_IN:
            await this._finishLogin(pb.str(e, 1));
            break;
        }
    }

    _abort(message) {
        this._client?.call('LoginAbort', new Writer().string(1, this._login.username).finish())
            .catch(() => {});
        this._login = null;
        this._setState('signed-out', message);
    }

    async _finishLogin(userID) {
        this._login = null;     // drop the password from memory
        this._setState('working');
        const user = parseUser(await this._client.call('GetUser', stringValue(userID)));
        this._user = user;
        this._username = user.addresses[0] ?? user.username;
        await this._loadServers();
        this._setState('signed-in');
    }

    async _signOut() {
        this._setState('working');
        if (this._user)
            await this._client.call('RemoveUser', stringValue(this._user.id));
        this._user = null;
        this._setState('signed-out');
    }

    _notifySignIn() {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: _('Proton Mail'),
                iconName: 'mail-unread-symbolic',
            });
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({
            source: this._source,
            title: _('Sign in to Proton Mail'),
            body: _('Your session ended. Sign in again to keep receiving mail.'),
        });
        notification.connect('activated', () => this.openPreferences());
        this._source.addNotification(notification);
    }
}
