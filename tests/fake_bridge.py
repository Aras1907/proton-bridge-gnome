#!/usr/bin/env python3
"""Fake Proton Mail Bridge core: serves the real bridge.proto gRPC API over a
TLS unix socket and writes grpcServerConfig.json, like `bridge --grpc` does.

Accounts (password "pass"):
  user@proton.me   plain login
  2fa@proton.me    needs TOTP code 123456
  two@proton.me    needs mailbox password "mbox"
  hv@proton.me     needs human verification first
"""
import base64, json, os, queue, signal, subprocess, sys, tempfile, threading, uuid
from concurrent import futures

import grpc
from grpc_tools import protoc

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = tempfile.mkdtemp()
protoc.main(['protoc', f'-I{HERE}', f'-I{os.path.dirname(protoc.__file__)}/_proto',
             f'--python_out={GEN}', f'--grpc_python_out={GEN}', f'{HERE}/bridge.proto'])
sys.path.insert(0, GEN)
import bridge_pb2 as pb  # noqa: E402
import bridge_pb2_grpc as pbg  # noqa: E402
from google.protobuf import empty_pb2, wrappers_pb2  # noqa: E402

if '--grpc' not in sys.argv:
    sys.exit('fake bridge: only --grpc is supported')

config_dir = os.path.join(os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config')),
                          'protonmail', 'bridge-v3')
os.makedirs(config_dir, exist_ok=True)
log = lambda *a: print('FAKEBRIDGE', *a, file=sys.stderr, flush=True)

d = tempfile.mkdtemp()
cert, key = os.path.join(d, 'cert.pem'), os.path.join(d, 'key.pem')
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
                '-keyout', key, '-out', cert, '-days', '1'], check=True, capture_output=True)
cert_pem, key_pem = open(cert, 'rb').read(), open(key, 'rb').read()
token = str(uuid.uuid4())
sock = os.path.join(tempfile.gettempdir(), f'fakebridge-{os.getpid()}.sock')

events = queue.Queue()
users = {}
pending = {}
stop = threading.Event()

def send(**login):
    events.put(pb.StreamEvent(login=pb.LoginEvent(**login)))

def finish(name):
    uid = 'uid-' + name.split('@')[0]
    users[uid] = pb.User(id=uid, username=name, state=pb.CONNECTED, password=b'bridge-pw-123',
                         addresses=[name, 'alias@' + name.split('@')[1]])
    send(finished=pb.LoginFinishedEvent(userID=uid))

def check_token(context):
    if dict(context.invocation_metadata()).get('server-token') != token:
        context.abort(grpc.StatusCode.UNAUTHENTICATED, 'bad token')

class Bridge(pbg.BridgeServicer):
    def Login(self, req, ctx):
        check_token(ctx)
        pw = base64.b64decode(req.password).decode()
        log('Login', req.username, 'hv' if req.useHvDetails else '')
        if pw != 'pass':
            send(error=pb.LoginErrorEvent(type=pb.USERNAME_PASSWORD_ERROR, message='wrong'))
        elif req.username == 'hv@proton.me' and not req.useHvDetails:
            send(hvRequested=pb.LoginHvRequestedEvent(hvUrl='https://verify.proton.me/?methods=captcha&token=x'))
        elif req.username == '2fa@proton.me':
            pending['user'] = req.username
            send(tfaRequested=pb.LoginTfaRequestedEvent(username=req.username))
        elif req.username == 'two@proton.me':
            pending['user'] = req.username
            send(twoPasswordRequested=pb.LoginTwoPasswordsRequestedEvent(username=req.username))
        else:
            finish(req.username)
        return empty_pb2.Empty()

    def Login2FA(self, req, ctx):
        check_token(ctx)
        code = base64.b64decode(req.password).decode()
        log('Login2FA', code)
        if code == '123456':
            finish(pending.pop('user'))
        else:
            send(error=pb.LoginErrorEvent(type=pb.TFA_ERROR, message=''))
        return empty_pb2.Empty()

    def Login2Passwords(self, req, ctx):
        check_token(ctx)
        if base64.b64decode(req.password).decode() == 'mbox':
            finish(pending.pop('user'))
        else:
            send(error=pb.LoginErrorEvent(type=pb.TWO_PASSWORDS_ERROR, message=''))
        return empty_pb2.Empty()

    def LoginAbort(self, req, ctx):
        check_token(ctx)
        log('LoginAbort')
        pending.clear()
        return empty_pb2.Empty()

    def GetUserList(self, req, ctx):
        check_token(ctx)
        return pb.UserListResponse(users=list(users.values()))

    def GetUser(self, req, ctx):
        check_token(ctx)
        if req.value not in users:
            ctx.abort(grpc.StatusCode.NOT_FOUND, f'user not found {req.value}')
        return users[req.value]

    def RemoveUser(self, req, ctx):
        check_token(ctx)
        log('RemoveUser', req.value)
        users.pop(req.value, None)
        return empty_pb2.Empty()

    def MailServerSettings(self, req, ctx):
        check_token(ctx)
        return pb.ImapSmtpSettings(imapPort=1143, smtpPort=1025)

    def RunEventStream(self, req, ctx):
        check_token(ctx)
        log('RunEventStream', req.ClientPlatform)
        ctx.add_callback(lambda: (log('stream closed by client, quitting'), stop.set()))
        while not stop.is_set():
            try:
                yield events.get(timeout=0.5)
            except queue.Empty:
                pass

    def StopEventStream(self, req, ctx):
        check_token(ctx)
        stop.set()
        return empty_pb2.Empty()

server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
pbg.add_BridgeServicer_to_server(Bridge(), server)
server.add_secure_port(f'unix:{sock}', grpc.ssl_server_credentials([(key_pem, cert_pem)]))
server.start()
with open(os.path.join(config_dir, 'grpcServerConfig.json'), 'w') as f:
    json.dump({'port': 0, 'cert': cert_pem.decode(), 'token': token, 'fileSocketPath': sock}, f)
log('listening', sock)
signal.signal(signal.SIGTERM, lambda *a: stop.set())
stop.wait()
server.stop(0)
if os.path.exists(sock): os.unlink(sock)
log('exited')
