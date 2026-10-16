// Runs the Proton Mail Bridge core in gRPC mode and restarts it if it stops.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SIGTERM = 15;
const MAX_FAILURES = 5;
const STABLE_UPTIME = 60;   // seconds after which a crash no longer counts as a startup failure

// The Bridge core ships inside the extension (bin/, built by bridge/build.sh).
// Zip installs can drop the executable bit, so it's restored here.
export function bundledBridge(extensionDir) {
    const path = GLib.build_filenamev([extensionDir, 'bin', 'proton-bridge']);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;
    if (!GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) {
        try {
            Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', 0o755,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return null;
        }
    }
    return path;
}

export const BridgeState = {
    STOPPED: 'stopped',
    RUNNING: 'running',
    RESTARTING: 'restarting',
    FAILED: 'failed',
};

export class BridgeProcess {
    constructor(onState) {
        this._onState = onState;
        this._state = BridgeState.STOPPED;
        this._detail = '';
        this._failures = 0;
    }

    get state() {
        return this._state;
    }

    get detail() {
        return this._detail;
    }

    _setState(state, detail = '') {
        this._state = state;
        this._detail = detail;
        this._onState(state, detail);
    }

    start(path) {
        this.stop();
        this._wanted = true;
        this._failures = 0;
        this._path = path;
        if (this._proc)
            this._relaunch = true;  // wait until the old instance has exited
        else
            this._launch();
    }

    _launch() {
        let proc;
        try {
            // Executed directly, no shell. Output is discarded: Bridge keeps its own logs.
            proc = Gio.Subprocess.new([this._path, '--grpc'],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._setState(BridgeState.FAILED, e.message);
            return;
        }
        this._proc = proc;
        this._startedAt = GLib.get_monotonic_time();
        this._setState(BridgeState.RUNNING);
        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
            } catch {}
            this._onExit(p);
        });
    }

    _onExit(proc) {
        if (proc !== this._proc)
            return;
        this._proc = null;

        if (this._relaunch) {
            this._relaunch = false;
            this._launch();
            return;
        }
        if (!this._wanted) {
            this._setState(BridgeState.STOPPED);
            return;
        }

        const uptime = (GLib.get_monotonic_time() - this._startedAt) / 1e6;
        if (uptime > STABLE_UPTIME)
            this._failures = 0;
        if (++this._failures >= MAX_FAILURES) {
            this._setState(BridgeState.FAILED,
                'Bridge keeps stopping. Is another copy of Proton Mail Bridge running?');
            return;
        }

        this._setState(BridgeState.RESTARTING);
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            2 ** this._failures, () => {
                this._restartId = 0;
                this._launch();
                return GLib.SOURCE_REMOVE;
            });
    }

    stop() {
        this._wanted = false;
        this._relaunch = false;
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = 0;
        }
        if (this._proc)
            this._proc.send_signal(SIGTERM);  // Bridge shuts down cleanly on SIGTERM
    }

    destroy() {
        this._onState = () => {};
        this.stop();
        this._proc = null;
    }
}
