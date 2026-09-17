# Send-it-easy

A small browser-based file transfer server for devices on the same Wi-Fi network.

Version 3 adds local mDNS discovery and a friendly `.local` address, while retaining QR and IP fallbacks.

## Run

Requires Node.js 18 or newer.

```powershell
npm start
```

The terminal prints the access code and addresses to open on another device. It also prints a QR code for each address. Scan the QR code with the other device's camera to open the sharing page without typing the address. Open the address without adding the code; the browser will show a login page. Files uploaded through the browser are stored in `shared\`.

The terminal also prints a friendly address like `http://your-computer.local:8080` and advertises Send-it-easy using mDNS. This works when the network and device support local mDNS discovery. If it does not resolve, use the hotspot/Wi-Fi IP address or its QR code.

If Windows Firewall prompts for access, allow Node.js on **Private networks** only. Stop the server with `Ctrl+C`.

Stopping the host server with `Ctrl+C` disconnects every connected device and makes the sharing page unavailable. Files already saved in `shared\` are not deleted.

### Windows hotspot troubleshooting

If the other device is connected to this computer's Windows mobile hotspot, use the address labeled **Windows hotspot**. The server prints it explicitly, even if Node.js does not list the hotspot adapter. It normally looks like:

```text
http://192.168.137.1:8080
```

Do not use `localhost` or the regular Wi-Fi address (`192.168.1.x`) from the connected device. After opening the address, enter the access code shown in the server terminal. If it still cannot connect, verify that:

1. The transfer server is still running.
2. The device is connected to this computer's hotspot, not a different Wi-Fi network.
3. Windows Firewall allows Node.js inbound connections on the active network.
4. The device can reach `192.168.137.1`; some managed or restricted hotspot configurations isolate clients.

If Windows uses a different hotspot address, set it before starting the server:

```powershell
$env:HOTSPOT_ADDRESS = "192.168.137.1"
npm start
```

## Friendly local address

The server advertises an mDNS service named `Send-it-easy` and prints a hostname based on the computer name. The `.local` address is convenient, but it is not guaranteed on every Windows hotspot or client device. Keep using the printed IP address or QR code when the friendly address does not resolve.

## Configuration

The defaults are suitable for a home network:

- Port: `8080` (override with `PORT=9000`)
- Access code: generated at each start (override with `ACCESS_CODE=MYCODE`)
- Shared folder: `shared\`
- Login session: expires after 8 hours or when the user selects **Disconnect**
- QR codes: generated locally in the terminal for each detected address
- mDNS service name: `Send-it-easy` (override with `SERVICE_NAME=My-Share`)
- Friendly hostname: based on the computer name, with `.local` appended

The current version intentionally shares only the configured shared folder and limits individual files to 5 GB.
