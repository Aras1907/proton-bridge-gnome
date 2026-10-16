// gjs -m tests/grpc-test.js <grpcServerConfig.json>  (against tests/fake_bridge.py)
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {BridgeClient, Writer, pb, stringValue} from '../src/lib/grpc.js';

const loop = new GLib.MainLoop(null, false);
const b64 = s => GLib.base64_encode(new TextEncoder().encode(s));
const login = (user, secret, hv = false) =>
    new Writer().string(1, user).bytes(2, new TextEncoder().encode(b64(secret))).bool(3, hv).finish();

async function main() {
    const config = Gio.File.new_for_path(ARGV[0]);
    const client = await BridgeClient.connect(config);
    const events = [];
    let waiter = null;
    const next = () => new Promise(resolve => {
        if (events.length)
            resolve(events.shift());
        else
            waiter = resolve;
    });
    const done = client.stream('RunEventStream', new Writer().string(1, 'linux').finish(), ev => {
        const [kind, body] = pb.oneof(ev);
        const [type, inner] = pb.oneof(body);
        const e = {kind, type, inner};
        if (waiter) {
            const w = waiter;
            waiter = null;
            w(e);
        } else {
            events.push(e);
        }
    });

    const check = (name, cond) => {
        print(`${cond ? 'PASS' : 'FAIL'} ${name}`);
        if (!cond)
            throw new Error(name);
    };

    await client.call('Login', login('2fa@proton.me', 'wrong'));
    let e = await next();
    check('wrong password -> error event', e.kind === 2 && e.type === 1 && pb.int(e.inner, 1) === 0);

    await client.call('Login', login('2fa@proton.me', 'pass'));
    e = await next();
    check('2fa requested', e.type === 2 && pb.str(e.inner, 1) === '2fa@proton.me');

    await client.call('Login2FA', login('2fa@proton.me', '000000'));
    e = await next();
    check('bad code -> TFA_ERROR', e.type === 1 && pb.int(e.inner, 1) === 3);

    await client.call('Login2FA', login('2fa@proton.me', '123456'));
    e = await next();
    const userID = pb.str(e.inner, 1);
    check('finished', e.type === 4 && userID === 'uid-2fa');

    const user = await client.call('GetUser', stringValue(userID));
    check('user password bytes', new TextDecoder().decode(pb.raw(user, 8)) === 'bridge-pw-123');
    check('user addresses', pb.strs(user, 9).join(',') === '2fa@proton.me,alias@proton.me');

    const settings = await client.call('MailServerSettings');
    check('ports', pb.int(settings, 1) === 1143 && pb.int(settings, 2) === 1025);

    try {
        await client.call('GetUser', stringValue('nope'));
        check('NOT_FOUND raised', false);
    } catch (err) {
        check(`NOT_FOUND raised (${err.code}: ${err.message})`, err.code === 5);
    }

    // Same server, tampered config: wrong token, then a foreign certificate.
    const original = JSON.parse(new TextDecoder().decode(config.load_contents(null)[1]));
    const variant = (name, changes) => {
        const file = Gio.File.new_for_path(`${GLib.path_get_dirname(ARGV[0])}/${name}.json`);
        file.replace_contents(JSON.stringify({...original, ...changes}), null, false, 0, null);
        return file;
    };
    const bad = await BridgeClient.connect(variant('bad-token', {token: 'x'}));
    try {
        await bad.call('GetUserList');
        check('bad token rejected', false);
    } catch (err) {
        check(`bad token rejected (${err.code})`, err.code === 16);
    }
    bad.close();

    const [, otherPem] = GLib.spawn_command_line_sync(
        'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=x -keyout /dev/null -days 1');
    try {
        await BridgeClient.connect(variant('foreign-cert', {cert: new TextDecoder().decode(otherPem)}));
        check('foreign certificate rejected', false);
    } catch (err) {
        check(`foreign certificate rejected (${err.message})`, true);
    }

    client.close();
    await done.catch(() => {});
    check('stream ends on close', true);
    print('ALL PASSED');
}

main().catch(e => print(`ERROR ${e}\n${e.stack}`)).finally(() => loop.quit());
loop.run();
