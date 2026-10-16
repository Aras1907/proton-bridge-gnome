// Interface between the shell extension (which owns Bridge) and the login window.
// Secrets flow in (Login, SubmitCode, …). The only secret that flows out is the
// Bridge mail password, via GetCredentials, once signed in.

export const DBUS_NAME = 'org.gnome.Shell';
export const DBUS_PATH = '/org/gnome/Shell/Extensions/ProtonBridge';
export const DBUS_IFACE = 'org.gnome.Shell.Extensions.ProtonBridge';

export const DBUS_XML = `
<node>
  <interface name="${DBUS_IFACE}">
    <method name="Login">
      <arg type="s" name="username" direction="in"/>
      <arg type="s" name="password" direction="in"/>
    </method>
    <method name="SubmitCode">
      <arg type="s" name="code" direction="in"/>
    </method>
    <method name="SubmitMailboxPassword">
      <arg type="s" name="password" direction="in"/>
    </method>
    <method name="ContinueVerification"/>
    <method name="Cancel"/>
    <method name="SignOut"/>
    <method name="Retry"/>
    <method name="GetCredentials">
      <arg type="s" name="email" direction="out"/>
      <arg type="s" name="password" direction="out"/>
      <arg type="s" name="imap" direction="out"/>
      <arg type="s" name="smtp" direction="out"/>
    </method>
    <property name="State" type="s" access="read"/>
    <property name="Error" type="s" access="read"/>
    <property name="Username" type="s" access="read"/>
    <property name="VerificationUrl" type="s" access="read"/>
  </interface>
</node>`;

/**
 * States:
 *   starting, failed,
 *   signed-out, working, code, mailbox-password, verify, signed-in
 */
