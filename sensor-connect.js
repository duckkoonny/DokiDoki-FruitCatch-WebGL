(() => {
  "use strict";

  const panel = document.querySelector("#sensor-panel");
  const toggle = document.querySelector("#sensor-toggle");
  const closePanel = document.querySelector("#sensor-close");
  const picker = document.querySelector("#sensor-ports");
  const connectSaved = document.querySelector("#sensor-connect-saved");
  const choose = document.querySelector("#sensor-choose");
  const disconnect = document.querySelector("#sensor-disconnect");
  const serialStatus = document.querySelector("#sensor-serial-status");
  const channels = document.querySelector("#sensor-channels");
  const cameraButton = document.querySelector("#sensor-camera");
  const cameraStatus = document.querySelector("#sensor-camera-status");
  const serial = navigator.serial;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let approved = [];
  let active = null;
  let busy = false;
  let generation = 0;
  let buffered = "";
  let camera = null;
  let cameraPacket = null;

  function updateButtons() {
    picker.disabled = !serial || busy || !!active || approved.length === 0;
    connectSaved.disabled = picker.disabled;
    choose.disabled = !serial || busy || !!active;
    disconnect.disabled = busy || !active;
  }

  function portLabel(port, index) {
    const {usbVendorId, usbProductId} = port.getInfo();
    const hex = value => value.toString(16).padStart(4, "0").toUpperCase();
    const id = usbVendorId != null && usbProductId != null ? " · USB " + hex(usbVendorId) + ":" + hex(usbProductId) : "";
    return "Approved port " + (index + 1) + id;
  }

  async function refreshPorts() {
    if (!serial) {
      serialStatus.textContent = "Open this page in desktop Chrome or Edge for USB sensors.";
      updateButtons();
      return;
    }
    const selected = approved[Number(picker.value)];
    try {
      approved = await serial.getPorts();
    } catch {
      approved = [];
    }
    picker.replaceChildren(...approved.map((port, index) => new Option(portLabel(port, index), index)));
    if (!approved.length) picker.add(new Option("No approved ports", ""));
    if (approved.includes(selected)) picker.value = approved.indexOf(selected);
    updateButtons();
  }

  function refreshChannels() {
    if (!active) {
      channels.textContent = "";
      return;
    }
    const now = performance.now();
    serialStatus.textContent = now - (active.lastData ?? -Infinity) < 1500
      ? "ESP32 connected · receiving data" : "Port open · waiting for ESP32 data";
    const types = [
      ["j", "Joystick"], ["d", "Gyro"], ["u", "Distance"], ["p", "Piezo"]
    ];
    channels.textContent = types.map(([type, name]) => name + " " +
      (now - (active.seen[type] ?? -Infinity) < 1500 ? "LIVE" : "—")).join(" · ");
  }

  function receive(state, chunk) {
    const pieces = (state.partial + decoder.decode(chunk, {stream: true})).split("\n");
    state.partial = pieces.pop();
    for (const raw of pieces) {
      if (!state.skipLine && raw.length <= 4096) {
        const line = raw.trim();
        if (line.startsWith("{")) {
          try {
            const packet = JSON.parse(line);
            const type = packet?.t;
            if (["j", "d", "r", "p", "u", "s"].includes(type)) {
              state.lastData = performance.now();
              const sensorReady = type === "d" ? packet.h?.some?.(hand => hand?.[3] === 1)
                : type === "u" || type === "p" ? packet.ok === 1 : true;
              if (sensorReady) state.seen[type] = state.lastData;
              else delete state.seen[type];
              buffered += line + "\n";
              if (buffered.length > 8192) buffered = buffered.slice(buffered.indexOf("\n", buffered.length - 7500) + 1);

            }
          } catch {
            // A partial or invalid packet is ignored until the next newline.
          }
        }
      }
      state.skipLine = false;
    }
    if (state.partial.length > 4096) {
      state.partial = "";
      state.skipLine = true;
    }
  }

  async function closeSerial(state, message) {
    if (active !== state) return;
    active = null;
    busy = true;
    buffered = "";
    updateButtons();
    try {
      await state.reader?.cancel();
      await state.reading;
      await state.writes;
      await state.port.close();
    } catch {
      // The device can already be gone after unplugging.
    } finally {
      serialStatus.textContent = message;
      busy = false;
      refreshChannels();
      await refreshPorts();
    }
  }

  async function readLoop(state) {
    try {
      while (active === state) {
        const {value, done} = await state.reader.read();
        if (done) break;
        if (active === state) receive(state, value);
      }
    } catch {
      // Disconnect or driver error.
    } finally {
      state.reader.releaseLock();
      state.reader = null;
      if (active === state) queueMicrotask(() => closeSerial(state, "ESP32 disconnected. Select the port to reconnect."));
    }
  }

  function writeSerial(line) {
    const state = active;
    if (!state || !["GET", "STREAM 1", "RAW 1", "PIEZOZERO"].includes(line)) return;
    state.writes = state.writes.then(async () => {
      if (active !== state || !state.port.writable) return;
      const writer = state.port.writable.getWriter();
      try {
        await writer.write(encoder.encode(line + "\n"));
      } finally {
        writer.releaseLock();
      }
    }).catch(() => {
      queueMicrotask(() => closeSerial(state, "Could not send to ESP32. Reconnect the port."));
    });
  }

  async function openSerial(getPort) {
    if (busy || active || !serial) return;
    busy = true;
    updateButtons();
    let port;
    let opened = false;
    try {
      port = await getPort();
      if (!port) return;
      await port.open({baudRate: 115200});
      opened = true;
      try {
        await port.setSignals({dataTerminalReady: false, requestToSend: false});
      } catch {
        // Some serial drivers do not implement modem control signals.
      }
      decoder.decode();
      buffered = "";
      const state = {
        port, generation: ++generation, reader: port.readable.getReader(),
        partial: "", skipLine: false, seen: Object.create(null), writes: Promise.resolve()
      };
      active = state;
      serialStatus.textContent = "Port open · waiting for ESP32 data";
      state.reading = readLoop(state);
      writeSerial("GET");
      writeSerial("STREAM 1");
    } catch (error) {
      if (opened) await port.close().catch(() => {});
      serialStatus.textContent = error.name === "NotFoundError"
        ? "No port selected." : "Could not open port. Close Serial Monitor or Unity and retry.";
    } finally {
      busy = false;
      await refreshPorts();
    }
  }

  function stopCamera(state, message) {
    if (camera !== state) return;
    camera = null;
    cameraPacket = null;
    state.controller?.abort();
    cameraButton.textContent = "Connect camera";
    cameraStatus.textContent = message;
  }

  async function pollCamera(state) {
    while (camera === state) {
      state.controller = new AbortController();
      const timeout = setTimeout(() => state.controller.abort(), state.reached ? 1500 : 30000);
      try {
        const response = await fetch("http://127.0.0.1:8765/gestures", {
          signal: state.controller.signal, cache: "no-store", credentials: "omit", targetAddressSpace: "loopback"
        });
        if (!response.ok) throw new Error("Camera helper: " + response.status);
        state.reached = true;
        const packet = await response.json();
        if (camera !== state) return;
        if (packet.version === 1 && Number.isSafeInteger(packet.seq)) {
          const key = packet.session + ":" + packet.seq;
          if (key !== state.last) {
            state.last = key;
            cameraPacket = JSON.stringify(packet);
          }
          cameraStatus.textContent = packet.cameraState === 2 ? "Camera live · gestures ready" : "Helper connected · waiting for camera";
        } else {
          cameraPacket = null;
          cameraStatus.textContent = "Helper connected · waiting for camera";
        }
      } catch (error) {
        if (camera !== state) return;
        cameraPacket = null;
        if (error.name !== "AbortError") {
          stopCamera(state, "Camera helper unavailable. Start it, then connect and allow local network access.");
          return;
        }
        cameraStatus.textContent = "Waiting for camera helper…";
      } finally {
        clearTimeout(timeout);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  window.dokiSensors = {
    connection: () => active?.generation ?? 0,
    readSerial() {
      const text = buffered;
      buffered = "";
      return text;
    },
    writeSerial,
    readCamera() {
      const text = cameraPacket;
      cameraPacket = null;
      return text;
    }
  };

  toggle.addEventListener("click", () => {
    if (panel.open) return;
    panel.showModal();
    // Unity's WebGL input captures keyboard events globally by default.
    for (const event of ["keydown", "keyup", "keypress"]) {
      panel.addEventListener(event, isolateKeyboard);
    }
    refreshPorts();
  });
  function isolateKeyboard(event) { event.stopPropagation(); }
  closePanel.addEventListener("click", () => panel.close());
  panel.addEventListener("close", () => document.querySelector("#unity-canvas").focus());
  choose.addEventListener("click", () => openSerial(() => serial.requestPort()));
  connectSaved.addEventListener("click", () => openSerial(() => approved[Number(picker.value)]));
  disconnect.addEventListener("click", () => active && closeSerial(active, "ESP32 disconnected"));
  serial?.addEventListener("connect", refreshPorts);
  serial?.addEventListener("disconnect", event => {
    if (active?.port === (event.port || event.target)) closeSerial(active, "ESP32 unplugged");
    else refreshPorts();
  });
  cameraButton.addEventListener("click", () => {
    if (camera) {
      stopCamera(camera, "Camera disconnected");
      return;
    }
    camera = {last: null};
    cameraButton.textContent = "Disconnect camera";
    cameraStatus.textContent = "Connecting to the camera helper…";
    pollCamera(camera);
  });
  refreshPorts();
  setInterval(refreshChannels, 400);
})();


