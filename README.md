# Proton Mail Bridge for GNOME

Sign in to Proton once, and the extension shows the Bridge password for your
address. Enter that password in your mail app (Convey, Geary, Evolution, …) to
sign in to Proton Mail.

Proton Mail Bridge is built in: the extension ships the Bridge core as one
static binary (`bin/proton-bridge`, no libc or other libraries needed, so it
runs on glibc and musl systems alike), runs it in the background and signs in
through its own API (two-factor codes, mailbox passwords and human
verification are supported). After sign-in, the window shows your email, the
Bridge password and the local IMAP/SMTP servers, each with a copy button.

The only UI is the sign-in window (Extensions → Proton Mail Bridge → Settings).
If your Proton session ever expires, a notification takes you back to it.

## Install

### One command (easiest)

```sh
curl -fsSL https://raw.githubusercontent.com/Aras1907/proton-bridge-gnome/main/install.sh | sh
```

It downloads the latest release for your CPU, installs it and enables it.
Then log out and back in and sign in with
`gnome-extensions prefs proton-bridge@aras.local`.

### From a release zip

Download the zip for your CPU (`x86_64` or `aarch64`) from the
[Releases page](../../releases/latest), then:

```sh
gnome-extensions install --force proton-bridge@aras.local.<arch>.zip
```

Log out and back in, enable it with
`gnome-extensions enable proton-bridge@aras.local`, and sign in with
`gnome-extensions prefs proton-bridge@aras.local`.

### From source

1. `make install` builds Bridge from source (first time only, a few minutes)
   and installs the extension. The build needs `gcc`, `git`, `curl` and a
   static libc; the Go toolchain and the pinned Bridge release are downloaded
   and checksum-verified into `.build/`. `make pack` makes an installable zip
   with Bridge included.
2. Log out and back in, then run `gnome-extensions enable proton-bridge@aras.local`.
3. Sign in: run `gnome-extensions prefs proton-bridge@aras.local`.

Don't run a separately installed Proton Mail Bridge at the same time. Only one
copy of Bridge can run.

### The built-in Bridge

`bridge/build.sh` builds the official Proton Mail Bridge release pinned in that
script, with `bridge/static-build.patch` applied. The patch removes the two
C-library dependencies that prevent a static build:

- **libfido2:** security-key sign-in. The sign-in window never supported it.
- **libsecret:** Bridge still stores its vault key in your keyring, through its
  built-in D-Bus Secret Service client.

To update Bridge, change `BRIDGE_TAG` (and the Go version, if Bridge needs a
newer one) and run `make install` again.

## Security

- **No secrets at rest in the extension.** Your Proton password goes straight
  to Bridge and is dropped from memory as soon as sign-in finishes. Bridge keeps
  its own vault in your keyring.
- **Bridge API:** the extension connects over Bridge's private unix socket with
  TLS, and accepts only the exact certificate that Bridge wrote to its config
  file for that run. It also authenticates with Bridge's per-run token.
- **Bridge runs without a shell.** The binary path is executed directly.
- **Mail stays on the device:** IMAP and SMTP listen only on `127.0.0.1`, with
  Bridge's self-signed certificate. When you add the account in GNOME Online
  Accounts (or another mail app), it warns that the certificate authority is
  not known: choose **Ignore** to accept it for this loopback connection.
- **The D-Bus interface** that the sign-in window uses accepts secrets as input.
  The only secret it returns is the generated Bridge password, and only while
  signed in (`GetCredentials`). Any program in your session can call it, so it
  has the same exposure as the keyring entry.

## Resources

When signed in, the extension adds no UI and does no polling. Its cost is one
idle local connection to Bridge. Bridge itself does the mail syncing. If Bridge
crashes, the extension restarts it, waiting longer after each failure, and
gives up after 5 quick failures.

## Development

```sh
make test   # gRPC/HTTP2 client against a fake Bridge (real bridge.proto),
            # then an end-to-end run in an isolated headless GNOME Shell with its
            # own D-Bus and keyring, driving the real
            # sign-in window. Screenshots are saved in .preview/e2e/
```

`tests/bridge.proto` is copied from Proton Mail Bridge (GPLv3). The bundled
Bridge binary is GPLv3 too; its source is the pinned release plus
`bridge/static-build.patch`.
