# Send-it-easy

A small browser-based file transfer server for devices on the same Wi-Fi network.

Version 4.4 supports host-approved screen sharing in both directions. The app now uses HTTPS as its normal address so file transfer and screen sharing work from the same link, and keeps a stable local certificate across restarts.

## Run

Requires Node.js 18 or newer.

```powershell
npm start
```

The terminal prints one secure address per network and a QR code for each. Scan the appropriate QR code, or open the printed HTTPS address. The browser will show a login page. Files uploaded through the browser are stored in `shared\`.

The terminal also prints a friendly address like `https://your-computer.local:8443` and advertises Send-it-easy using mDNS. This works when the network and device support local mDNS discovery. If it does not resolve, use the hotspot/Wi-Fi IP address or its QR code. Old HTTP links automatically redirect to HTTPS.

To list the computer's network interfaces and devices currently visible to Windows, run:

```powershell
npm run networks
```

The device table is based on Windows' ARP cache. It is not a guaranteed complete list; a device may appear only after communicating with the computer.

If Windows Firewall prompts for access, allow Node.js on **Private networks** only. Stop the server with `Ctrl+C`.

Stopping the host server with `Ctrl+C` disconnects every connected device and makes the sharing page unavailable. Files already saved in `shared\` are not deleted.

### Windows hotspot troubleshooting

If the other device is connected to this computer's Windows mobile hotspot, use the HTTPS address labeled **Windows hotspot**. The server prints it explicitly, even if Node.js does not list the hotspot adapter. It normally looks like:

```text
https://192.168.137.1:8443
```

Do not use `localhost` or the regular Wi-Fi address (`192.168.1.x`) from the connected device. After opening the address, enter the access code shown in the server terminal. If it still cannot connect, verify that:

1. The transfer server is still running.
2. The device is connected to this computer's hotspot, not a different Wi-Fi network.
3. Windows Firewall allows Node.js inbound connections on the active network.
4. The device can reach `192.168.137.1`; some managed or restricted hotspot configurations isolate clients.

If the server works at `https://localhost:8443` but hotspot devices cannot open it, add a narrowly scoped inbound firewall rule. Run PowerShell **as Administrator** on the host:

```powershell
New-NetFirewallRule `
  -DisplayName "Send-it-easy HTTPS (Local Network)" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 8443 `
  -RemoteAddress LocalSubnet `
  -Profile Private,Public
```

This permits HTTPS connections from local-subnet devices only. From another Windows laptop connected to the hotspot, check reachability with:

```powershell
Test-NetConnection 192.168.137.1 -Port 8443
```

If `TcpTestSucceeded` is `False`, the hotspot or firewall is still blocking the connection. If it is `True`, open `https://192.168.137.1:8443` and accept the local certificate warning if shown.

If Windows uses a different hotspot address, set it before starting the server:

```powershell
$env:HOTSPOT_ADDRESS = "192.168.137.1"
npm start
```

## Friendly local address

The server advertises an mDNS service named `Send-it-easy` and prints a hostname based on the computer name. The `.local` address is convenient, but it is not guaranteed on every Windows hotspot or client device. Keep using the printed IP address or QR code when the friendly address does not resolve.

Customize the friendly hostname and discovery name for one launch:

```powershell
$env:LOCAL_HOSTNAME = "sendit"
$env:SERVICE_NAME = "My Send-it-easy"
npm start
```

That produces a friendly address like `https://sendit.local:8443`. Use letters, numbers, and hyphens for the hostname.

## Configuration

The defaults are suitable for a home network:

- HTTPS application port: `8443` (override with `HTTPS_PORT=9443`)
- HTTP redirect port: `8080` (override with `PORT=9000`)
- Access code: generated at each start (override with `ACCESS_CODE=MYCODE`)
- Shared folder: `shared\`
- Login session: expires after 8 hours or when the user selects **Disconnect**
- QR codes: generated locally in the terminal for each detected address
- mDNS service name: `Send-it-easy` (override with `SERVICE_NAME=My-Share`)
- Friendly hostname: based on the computer name, with `.local` appended (override with `LOCAL_HOSTNAME=sendit`)
- Network inspection: `npm run networks`

The current version intentionally shares only the configured shared folder and limits individual files to 5 GB.

## Screen sharing

Screen sharing uses WebRTC and does not save video files or route the video through the Send-it-easy server.

1. On the host laptop, open the HTTPS address printed as **Open Send-it-easy** and log in.
2. On the host laptop, select **Share my screen** and choose a window, tab, or entire display.
3. On another logged-in device, select **Request to view host screen**.
4. Approve the request on the host laptop.
5. Stop sharing from the host page when finished.

Only the host laptop can share its screen. Connected devices can request to view the host screen, but they cannot share their own screen. The host must approve each viewer. The browser may show a permission prompt, and screen capture is supported only in browsers that provide `getDisplayMedia`. Remote devices use the normal hotspot, Wi-Fi, or friendly address to view.

### Screen sharing

All clients now use the same HTTPS address for file transfer and screen sharing, for example:

```text
https://192.168.137.1:8443
```

The app creates a local certificate on first run and stores it under `certs\`. It reuses this certificate across restarts, so you only need to trust it once per device. The login page also has a **Download this host's certificate** link. To remove the browser's **Not secure** warning, install that certificate as a trusted certificate authority on each device. On Windows, open the downloaded `.cer` file and import it into **Trusted Root Certification Authorities** for the current user or local computer. On Android, install it as a CA certificate under the device's security settings; exact menu names vary by OS version. Only trust this certificate for your own Send-it-easy host; it is generated locally and is not publicly verified. The app cannot silently install a trusted certificate on other devices.

If the certificate has not been trusted yet, the browser will still warn. Any old HTTP address automatically redirects to the same HTTPS app, so there is no separate screen-sharing URL. If the host's IP addresses change, the existing certificate may not cover the new address; regenerate the certificate by stopping the server, removing the files in `certs\` except `.gitkeep`, then starting the server and trusting the new certificate.

Browser screen-capture permission cannot be silent. When someone shares a screen, their browser must show its own chooser/permission prompt so they select the screen, window, or tab. The person must approve this action.

If screen sharing still is not available after opening the HTTPS app, the browser may not support `getDisplayMedia` on that device. Try an up-to-date desktop browser such as Chrome, Edge, or Firefox. The app displays a distinct message for an insecure page versus an unsupported browser.

If the host page shows **Request to view host screen** instead of **Share my screen**, refresh after logging in. The host page is now recognized through localhost, Wi-Fi, and hotspot addresses.

The viewer screen includes browser-style controls for play/pause, audio volume, mute, fullscreen, and switching between **Fit view** (show the entire screen) and **Fill view** (crop to use more of the available area). Fullscreen availability depends on the browser and device.
