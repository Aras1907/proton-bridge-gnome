// Drives the real login window against the extension running in a headless
// shell (see e2e.sh), checks the shown credentials, and saves screenshots.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Prefs from './prefs.js';

const [outDir] = ARGV;
const app = new Adw.Application({application_id: 'org.example.ProtonBridgeE2E'});
let failed = false;

const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

function check(name, cond) {
    print(`${cond ? 'PASS' : 'FAIL'} ${name}`);
    failed ||= !cond;
}

function goaAccounts() {
    const reply = Gio.DBus.session.call_sync('org.gnome.OnlineAccounts', '/org/gnome/OnlineAccounts',
        'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null, null, 0, -1, null);
    const [objects] = reply.recursiveUnpack();
    return Object.values(objects)
        .filter(i => i['org.gnome.OnlineAccounts.Account']?.ProviderType === 'imap_smtp')
        .map(i => ({...i['org.gnome.OnlineAccounts.Account'], mail: i['org.gnome.OnlineAccounts.Mail']}));
}

app.connect('activate', async () => {
    const win = new Adw.PreferencesWindow({application: app});
    const prefs = Object.create(Prefs.prototype);
    prefs.fillPreferencesWindow(win);
    win.present();

    const state = () => prefs._prop('State');
    const waitFor = async (want, timeout = 20000) => {
        for (let t = 0; t < timeout && state() !== want; t += 100)
            await sleep(100);
        await sleep(400); // let the UI settle
        return state() === want;
    };
    const shot = name => {
        const paintable = new Gtk.WidgetPaintable({widget: win});
        const snap = new Gtk.Snapshot();
        paintable.snapshot(snap, win.get_width(), win.get_height());
        win.get_renderer().render_texture(snap.to_node(), null).save_to_png(`${outDir}/${name}.png`);
    };
    const click = (page, i = 0) => prefs._pages[page].buttons[i].emit('clicked');

    try {
        check('bridge starts, signed out', await waitFor('signed-out', 40000));
        shot('1-login');

        prefs._email.text = '2fa@proton.me';
        prefs._password.text = 'wrong';
        click('signed-out');
        await sleep(1500);
        check('wrong password shows error', prefs._pages['signed-out'].error.visible);
        check('password field cleared', prefs._password.text === '');
        shot('2-login-error');

        prefs._password.text = 'pass';
        click('signed-out');
        check('2FA requested', await waitFor('code'));
        shot('3-code');

        prefs._code.text = '000000';
        click('code');
        await sleep(1500);
        check('bad code shows error, stays on code', state() === 'code' && prefs._pages.code.error.visible);
        shot('4-code-error');

        prefs._code.text = '123 456';
        click('code');
        check('signed in', await waitFor('signed-in'));
        shot('5-signed-in');

        await sleep(500);
        check(`credentials shown: ${prefs._creds.email.subtitle} / ${prefs._creds.imap.subtitle}`,
            prefs._creds.email.subtitle === '2fa@proton.me' && prefs._creds.password.subtitle.length > 0 &&
            prefs._creds.imap.subtitle === '127.0.0.1:1143' && prefs._creds.smtp.subtitle === '127.0.0.1:1025');
        check('no GOA account auto-created', !goaAccounts().some(a => a.Identity === '2fa@proton.me'));
        shot('5b-credentials');

        prefs._call('SignOut');
        check('signed out again', await waitFor('signed-out'));

        prefs._email.text = 'hv@proton.me';
        prefs._password.text = 'pass';
        click('signed-out');
        check('human verification requested', await waitFor('verify'));
        check('verification URL exposed', prefs._prop('VerificationUrl').startsWith('https://'));
        shot('6-verify');
        click('verify', 1);
        check('signed in after verification', await waitFor('signed-in'));
    } catch (e) {
        check(`exception ${e}\n${e.stack}`, false);
    }
    print(failed ? 'E2E FAILED' : 'E2E PASSED');
    app.quit();
});
app.run([]);
