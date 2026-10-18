UUID := proton-bridge@aras.local
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
VENV := tests/.venv
BRIDGE := src/bin/proton-bridge
# CPU the bundled Bridge is built for (bridge/build.sh builds for this machine).
ARCH := $(patsubst arm64,aarch64,$(patsubst amd64,x86_64,$(shell uname -m)))
ZIP := dist/$(UUID).$(ARCH).zip

.PHONY: install uninstall pack test venv bridge

# Proton Mail Bridge core, built from source as a static binary and shipped
# inside the extension (see bridge/build.sh).
bridge: $(BRIDGE)
$(BRIDGE): bridge/build.sh bridge/static-build.patch
	bridge/build.sh $@

install: $(BRIDGE)
	rm -rf "$(DEST)"
	mkdir -p "$(DEST)"
	cp -r src/. "$(DEST)/"

uninstall:
	rm -rf "$(DEST)"

# Zip for `gnome-extensions install`, named for this CPU like the release
# assets that install.sh downloads (x86_64 or aarch64).
pack: $(BRIDGE)
	mkdir -p dist
	rm -f "$(ZIP)"
	cd src && zip -qr "../$(ZIP)" metadata.json extension.js prefs.js lib bin
	@echo "Packed $(ZIP)"

# Fake Bridge (real bridge.proto over gRPC) needs grpcio.
venv: $(VENV)/bin/python
$(VENV)/bin/python:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q grpcio grpcio-tools

# 1. gRPC/HTTP2 client against the fake Bridge.
# 2. Full flow in an isolated headless GNOME Shell (own D-Bus, keyring, GOA),
#    driving the real login window; screenshots in .preview/e2e/.
test: venv
	@cfg=$$(mktemp -d); \
	XDG_CONFIG_HOME=$$cfg tests/fake-bridge --grpc & pid=$$!; \
	for i in $$(seq 50); do [ -f $$cfg/protonmail/bridge-v3/grpcServerConfig.json ] && break; sleep 0.2; done; \
	gjs -m tests/grpc-test.js $$cfg/protonmail/bridge-v3/grpcServerConfig.json; status=$$?; \
	kill $$pid 2>/dev/null; rm -rf $$cfg; [ $$status -eq 0 ]
	mkdir -p .preview/e2e
	tests/e2e.sh .preview/e2e | grep -E "PASS|FAIL|E2E|JS ERROR"
